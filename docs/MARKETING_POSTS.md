# Marketing posts: the brand channel (Telegram first)

Status: **designed; slices 1 to 6 are built and everything is OFF** (migration 0108, `docs/news/`, the sender, the
worker and the owner page). Nothing posts anything today: the worker is not deployed and the page shows only an "off" note
until the owner switches them on. "(unverified)" marks a fact that was not confirmed in the repository or in the official
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
plans / plan_entitlements   ──►  (tools/marketing_worker.py)                           │
                                                                              owner page /{channel}/marketing
                                              owner_marketing_edit / approve / reject / kill
                                                                                       │ approved
marketing worker ◄── claim_marketing_post (one post, under a lock) ◄──────────────────┘
      │ sendMessage / sendPhoto / sendVideo to the one configured channel
      └──► complete_marketing_post (sent | failed | dead | retry)
```

### Source of truth for news: a reviewed file, not a model

One file per announceable change in `docs/news/`, added in the pull request that ships it
([format and rules](news/README.md)). Claude drafts the three texts in that pull request and the owner merges it,
so every claim is a reviewed diff line. The worker image contains the deployed commit's `docs/` (the Dockerfile
copies the repository and `.dockerignore` does not exclude `docs/`). `deploy_web.yml` runs on a push to `main` that
touches `docs/news/**` (as well as `modules/**`, `tools/**`, `deploy/**` and the rest), and `remote-deploy.sh` starts the
marketing worker with `up -d --build` while it is switched on, so a merged news file reaches the worker's image on
that deploy. Only what is deployed can be announced. `public: true` is a human decision per file; security work
is never news by default. **No language model in phase 1**: templates plus Claude-written pull request text remove a
whole class of invented claims. Mechanical checks (`tests/test_news_format.py`): three languages, a short paragraph
each in its own script, the same numbers in all three, no placeholder or URL, and the banned-claims list.

### Tables (migration `0108_marketing_posts.sql`)

- `marketing_posts`: kind `news | showcase | price`, `target` (`telegram` only; a column so Instagram later is a new
  sender and token, not a redesign), the status, `texts` (exactly `uz`, `ru`, `en`), `media_path` (public `showcase/`
  bucket only), `link` (a path on our own site), `source_ref` (`pr:#N`, `plan:<ids>`, `asset:<uuid>`), `facts` with `facts_as_of`, the approval
  (`approved_by`, `approved_at`, `approved_hash`, `expires_at`), the send record, and a unique `idempotency_key`
  (`news:<slug>`, `price:<plan-set>:<yyyy-mm>`, `showcase:<asset id>`), so the same thing is never drafted twice.
- `marketing_settings`: one row. `enabled` (false), `max_per_7d` (2, `CHECK` 0..2), `facts_max_age_hours` (24),
  `approval_ttl_hours` (72).
- `showcase_assets`: the explicit "this video is public" list, limited by a `CHECK` to the operator's own
  organization. Closed; its owner functions come later.

Row-level security is on for all three and every API role's table grants are revoked. Only a platform admin may
`SELECT` `marketing_posts` (one policy). Every write is a `SECURITY DEFINER` function with a pinned `search_path`.
The browser never holds the service key.

### Status machine (a trigger: it holds for the API roles, the owner functions and the worker)

```
draft ─► approved ─► sending ─► sent | failed | dead
  │         │  ▲         └─► approved   (only a request that never left: rate limit, refused connection)
  │         └─► draft    (an edit voids the approval)
  ├─► rejected
  └─► expired      (draft or approved)
```

- **Approval** needs the approver, the time, an expiry and a hash equal to the hash of the content as it stands. The
  hash covers everything the sender puts in the message: kind, target, media, **link** and the three texts.
  `owner_marketing_approve(id, content_hash)` takes the hash the owner was looking at and refuses if the post
  changed since (`content_changed`), if a price post's facts are older than 24 h, if the week's slots are already
  used or promised, **or while the poster is switched off (`poster_off`)**: with the switch off nothing can be
  claimed, so an approval would lapse unsent after 72 h and use up the post's key (a news item is drafted once).
  Re-arm first, then approve. An approval that already lapsed is answered `expired` and the post is expired, never
  "already approved".
- **The worker never overwrites a person's words.** `marketing_draft_upsert` updates a draft only while nobody has
  edited it (`edited_at` is empty), so an owner edit, including an edit that sent an approved post back to draft,
  survives the next pass over the news files.
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
- **A showcase post must carry its video** (a `CHECK`). In the showcase slice the claim must also join a *live*
  `showcase_assets` row (not revoked), so revoking a video stops a post that has not gone out yet. That join is not
  built here.
- **Final rows are frozen and no row is deleted**: a deleted row would forget its key and let a news item be drafted
  again.

### Owner actions and audit

`owner_marketing_get / edit / approve / reject / kill` go through `owner_guard()` of migration 0107: signed in,
platform owner/admin, the second factor (`admin_aal_ok()`), a per-person rate limit. Each writes `app_audit_log` and
`security_events` in the same transaction, so a change whose audit cannot be written does not happen. Audit names:
`marketing.edit | approve | reject | send | fail | kill`, and `showcase.mark | revoke` (reserved). The kill switch
(`owner_marketing_kill(true)`) stops claims at once; re-arming (`false`) needs a written reason.

## Safety

- **What the database owner can still do.** The cap, the kill switch and the status machine protect against bugs and
  against every API caller. A superuser (the SQL editor) can disable the trigger, set `session_replication_role`, or
  update `marketing_settings` directly, and so step around them. That is the owner's own access, not a hole in the
  API, but it means the controls are not a defence against someone who holds the database password.
- **Turn the 0107 second-factor gate on before re-arming the poster.** While `owner_security_settings.admin_aal2_required`
  is false, a password-only admin session passes `owner_guard()` and could approve a public post
  (`docs/security/ADMIN_MFA.md`).
- **No auto-publish.** The database allows `sending` only from `approved` with a matching hash and a live approval.
  `marketing_settings.enabled` is false until the owner re-arms it. The app (the owner page) and the worker share one more
  switch (`NIGHTSHIFT_MARKETING_POSTS`, default off); both must be on.
- **Unknown is not a number.** Prices and limits come only from `plans` / `plan_entitlements` at draft time; facts
  carry `facts_as_of`; a failed read produces no draft, not a default. The free entry is "a one-time welcome grant
  of 100 credits" (migration 0027), never "free".
- **No claims we cannot back**: `docs/news/banned-claims.json` (free, unlimited, guaranteed, best, income or views
  promises, certainty words, endorsement, provider and model names). Showcase posts must say the video is a sample
  made with the product and must not imply endorsement by YouTube or any provider. Whether local law or YouTube
  requires an AI-disclosure label is not defined in the repository: ask the owner.
- **Secrets.** A dedicated bot token that appears only inside the request URL held by `TelegramClient`; logs carry
  codes and counts only; a test sends a fake token through every failure path. Never reuse the
  operator bot's or the customer bot's token: the customer bot would give the customer notify worker the power to
  post publicly.
- **Failures are visible** with a closed code list (`blocked`, `bad_request`, `not_configured`, `rate_limited`,
  `network`, `http_5xx`, `unconfirmed`, `expired`) and the fix named for each on the owner page.

## What is built and what is not

| # | Slice | State |
|---|---|---|
| 1 | `docs/news/` format, banned claims, `tests/test_news_format.py`, this document | built |
| 2 | Migration 0108 and its security-lab tests, rollback `docs/sql/rollback_0108_marketing_posts.sql` | built, dormant |
| 3 | Telegram sender: `modules/channel_post.py` (`sendMessage`, `sendPhoto`, `sendVideo`), the fake server | built, unused until the worker is switched on |
| 4 | `tools/marketing_worker.py`, compose service `marketing-worker` (profile `marketing`), `deploy/.env.marketing.example`, deploy wiring | built, **off by default** |
| 5 | News drafting from `docs/news`, price template from the database (`modules/marketing_content.py`) | built, off with the worker |
| 6 | Owner page `/{channel}/marketing`, `POST /api/marketing`, en/ru/uz strings, confirm sheets, all states, 390 px (below) | built, **off by default** (`NIGHTSHIFT_MARKETING_POSTS`) |
| 7 | Operator-bot alert kind `marketing` and `/marketing` (counts, kinds and closed codes only; no text, no approve) through migration 0109 `operator_marketing_summary()` | built, information only |
| 8 | Showcase mark/revoke, public bucket, showcase posts (the biggest unknown: where a finished video file lives and how to export it) | not started |
| 9 | A currency amount in price posts (a timestamped capture); Instagram | not decided |

Approval is the owner functions of 0108 (`owner_marketing_approve`), and the only screen that calls them is the owner
page below. A draft reaches the channel only after a person approved exactly the words on the screen, with every switch on.

## The owner page (slice 6)

`/{channel}/marketing`, in the operator's navigation (System group) and in All sections on a phone. Behind
`guardOperatorPage()` like every operator page (signed out goes to `/login`, anyone else gets 404, a missing second step goes
to the code page).

**The switch.** `NIGHTSHIFT_MARKETING_POSTS`, read per request, exactly `on` (surrounding spaces ignored, as the worker does).
It is the **same repository variable the worker reads**, mapped into the web container as `WEBENV_NIGHTSHIFT_MARKETING_POSTS`
(`.github/workflows/deploy_web.yml`, `deploy/.env.web.example`), so one variable switches both. Anything else: the page shows an
"off" note, makes **no database read at all**, and `POST /api/marketing` answers 404. `MARKETING_TELEGRAM_CHAT` (the channel's
public `@name` or numeric chat id, also the worker's variable, validated by the deploy's own rule) and `NOTIFY_APP_ORIGIN` are
mapped the same way so the confirm sheet can name the channel it publishes to and the preview can count the link. If the channel
is missing or not valid the page says so, never guesses, and **disables Approve** (the sheet could not say where it goes public).

**Reads** (as the signed-in owner, anon key and cookie session, no service key): `owner_marketing_get()` for the poster state, the
week's count and the waiting approvals, and the newest 40 `marketing_posts` (`facts` is not read). One unreadable row, a failed
read or a settings answer without `enabled` makes the whole page "could not read, Retry": never an empty list, never "0 of 2".
Migration 0108 not applied shows "not installed yet".

**What it shows.** The poster state (on, or off), the channel, "posts this week: n of 2" and how many approved posts wait; the
last send; then each post, drafts and approvals first: kind, status, source (`pr:#N`), age, and the **preview of exactly what
Telegram will show** (the three language blocks in the fixed order uz, ru, en, then the link and the media) with the character
count of each language and of the whole message against the limit (4096, 1024 with a photo or video), counted in UTF-16 units.
The preview is a TypeScript mirror of `modules/channel_post.py` (`lib/marketing-posts.ts` `buildPreview`); it cannot import
Python, so `tests/fixtures/marketing_message_cases.json` is run through both the real renderer
(`tests/test_marketing_message_fixture.py`) and the mirror (`command-center/tests/marketing-posts.test.ts`), for every refusal code
the sender can give (`bad_texts`, `bad_link`, `no_origin`, `unsafe_text`, `too_long`), including the key- and e-mail-shaped
text rule of `modules/tg_text.sanitize_outgoing` and a host's port kept as typed. The links are completed with the origin the
worker uses: `NOTIFY_APP_ORIGIN` when set (mapped into the web env), else the site's own `APP_ORIGIN`; a set but invalid value, or
neither, is unknown, and then the link is left out of the count and the total reads "at least".

**What it does**, all through `POST /api/marketing` (one route, an `action`: `edit`, `approve`, `reject`, `kill`; there is no
other, so no "send now" and no "test post", in any language or in the code):

| Action | Function | Guard on the screen |
|---|---|---|
| Edit the three texts | `owner_marketing_edit(id, texts)` | live counts and preview; Save is off for an empty language or an over-long message; editing an **approved** post asks first, because saving voids the approval |
| Approve | `owner_marketing_approve(id, content_hash)` | confirm sheet with the channel name, the kind, the attached file (when there is one), all three texts, the link, the message size and "this goes public"; a typed word (`publish` / `опубликовать` / `nashr`); sends **the hash this page showed**, so a post that changed is refused with `content_changed` and the page reloads. **Disabled, with the reason on the screen,** while the poster is off (`poster_off`), while the channel is unknown, and while the page's own preview says the sender would refuse the post (too long for a message or, with a photo or video, a caption; key- or address-shaped text; a bad link). Edit and Reject stay available |
| Reject | `owner_marketing_reject(id, reason)` | reason of 8 to 300 characters, then a confirm sheet; an approved post is withdrawn |
| Stop the poster | `owner_marketing_kill(true)` | confirm sheet |
| Switch the poster on | `owner_marketing_kill(false, reason)` | a written reason (8 to 300), a confirm sheet and the typed word |

Every refusal (`poster_off`, `content_changed`, `cap_full`, `expired`, `facts_stale`, `bad_texts`, `not_draft`, `reason_required`,
`mfa_required`, `rate_limited` and the route's own) has a sentence in English, Russian and Uzbek, with the figures the database
sent; the database's own English text is dropped. A page made stale by a refusal reloads when the sheet closes.

**The database's second-factor gate** (0107, `admin_aal2_required`) is shown read only in the poster panel (the same `owner_security_get` read as the Security page): on, off with the risk said (a password-only session can approve a public post), or unknown when it could not be read, never "off" for an unreadable answer. The page has no control for it.

**The guard stack of the route** is the owner routes' own (`handleOwnerPost`, now taking the switch as a parameter): same-origin
first (403), the switch (404), signed in (401), owner/admin (403), the application second-factor gate (`guardAdminPost`), a capped
JSON body validated by `parseMarketing` (400 with a code), then **one** rpc as the signed-in user. The database repeats the checks
(`owner_guard()`: platform admin, `admin_aal_ok()`, a rate limit) and writes the audit trail.

**How a send looks afterwards.** `sent`: when. `dead` (unconfirmed, or a 5xx): **"check the channel, do not resend"**; the post
keeps its slot for the week and is never sent again by itself, and the page offers no resend. `failed` and a retrying `approved`
post name the fix for their code: `blocked` (the bot is not a channel administrator: add it with only "Post messages"),
`not_configured` (Telegram refused the token: replace `TELEGRAM_CHANNEL_BOT_TOKEN`, a secret that is never typed on this page),
`bad_request` (check `MARKETING_TELEGRAM_CHAT` and the text), `rate_limited` and `network` (it retries by itself), `expired`.

**How to approve, in this order** (the poster is off until you do step 2, and the page will not let you approve before it):

1. Switch the worker on: the variables `NIGHTSHIFT_MARKETING_WORKER` and `NIGHTSHIFT_MARKETING_POSTS` = `on`, then run Deploy web
   (this also turns the page on). Point `MARKETING_TELEGRAM_CHAT` at the **test** channel first.
2. Re-arm the database switch: on the page, "Switch the poster on", with a reason, the confirm sheet and the typed word (or
   `owner_marketing_kill(false, '<reason>')` in the SQL editor). Check first that the 0107 second-factor gate is on
   (`docs/security/ADMIN_MFA.md`): until it is, a password-only admin session passes `owner_guard()`.
3. Only then open a draft, read the preview in all three languages (the Russian and Uzbek wording is a machine draft), and
   **Approve**. Nothing is sent by the tap: the worker posts it within a few minutes, while the poster is on, inside the week's
   two slots. Look at the channel.

Not verified here: the page has not been opened on a phone or against a live database; it is covered by unit and component tests
and by `next build`, not by a browser.

### Rows this page version does not know (tolerance)

A database may hold a post whose `kind` or `target` this page was built before (a later migration adds them). The page
lists it as **Other kind / Other target: <code>** (the code only if it is `[a-z_]{1,24}`, else `unknown`), with its
status and age, and its words only if they have the known three-language shape (else "preview unavailable"). It is never dropped
and never counted as 0. It cannot be approved, edited or rejected here: Approve is disabled with "this page version cannot approve
this kind: the page needs updating (a new deploy)". Extra JSON fields and unknown error codes are ignored or shown as a closed code, never as free text.
The operator bot names such a kind `other` (counts per status already cover every kind).

**Deploy order.** Any migration that adds a status, kind or target, or widens a column the approval page validates, needs a page
deploy FIRST: the page fails closed on a status it does not know (the whole list reads "could not read"), and it can only list an
unknown kind or target as Other once this tolerance is deployed. Tolerance for `delivery` is NOT implemented yet: the page does not
select the `delivery` column (`POST_COLUMNS`), so it cannot see or list a post by its delivery. The delivery migration must ship
together with, or after, a page change that reads `delivery`.

## The worker (slices 3 to 5)

`tools/marketing_worker.py`, compose service `marketing-worker` (profile `marketing`, its own env file
`/opt/nightshift/.env.marketing`, mode 600, exactly the names in `deploy/.env.marketing.example`).

**Three switches, all off by default.**

| Switch | Where | Off means |
|---|---|---|
| `NIGHTSHIFT_MARKETING_WORKER` | GitHub variable, read by `deploy_web.yml` | no container, no env file, no secret needed |
| `NIGHTSHIFT_MARKETING_POSTS` | GitHub variable, in the worker's env file | anything but `on`: the worker idles. No draft, no claim, no request to Telegram. It still calls `report_worker_status` about once a minute (`running`, detail "off", kind `other`) so `/health` shows it |
| `marketing_settings.enabled` | the database (0108) | `claim_marketing_post` hands out nothing |

The worker cannot read the database switch (every API role's grant on the marketing tables is revoked, by design), so
with the database switch off it still drafts, and claims return nothing. A draft left untouched for 30 days expires and
its key is used up, so re-arm the database switch soon after the environment switch (the hand steps below do).
To keep a first start from drafting a backlog, **a news item whose `shipped` date is more than 30 days old is not
drafted** (`NEWS_MAX_AGE_DAYS` in `modules/marketing_content.py`; the log says how many were left out). Flip an item to
`public: true` within 30 days of shipping, or edit its `shipped` date (and the file name's date, which must agree) to
announce it later. After each drafting pass the log says how many new drafts are waiting for approval.

**Each loop** (a minute apart): (1) at most once an hour, draft: every `docs/news/*.json` with `"public": true`
(re-checked: shape, banned claims, not in the future; a file that fails is skipped by reason, never posted) and the
month's price post. **Each draft is first run through the sender's own `render`** (`channel_post.preflight`); a draft the sender
would refuse (`too_long`, `unsafe_text`, `bad_link`, `bad_texts`, or `no_origin` for a link with no usable site origin) is not
stored, so it never reaches the owner only to fail after approval and use up its key. The log carries the count and the codes,
never the words; (2) claim **at most one** approved post, send it, settle it.

**Price post.** Built from `plans`, `plan_entitlements` and `entitlement_keys` only: the plan name, credits per month and
concurrency of each public paid plan, plus the link `/pricing`. **No currency amount, ever** (there is none in the
database, and rule 5 of `CLAUDE.md` forbids typing one). If any read fails, any fact is not a number, or `concurrency` is
not an enforced entitlement, no price post is made (no default). The key is `price:<plan ids>:<yyyy-mm>`: at most one per
month per plan set. The Uzbek and Russian wording of the template is a machine draft; the owner reads all three before
approving.

**Settling.** After a send, `complete_marketing_post` is retried up to three more times (0.5, 1 and 2 seconds apart, and
not after 90 seconds from the claim, inside the 120-second lease) if the database does not answer. Only the settle is
repeated, never the send. If every try fails, the lease runs out and the database ends the post as `dead` /
`unconfirmed`; it is not sent again. At start the log names the origin host in use (host only) and whether the chat is a
channel name or a numeric id, never the token or the chat itself.

**What the message is.** One message, three labelled blocks in the fixed order (Oʻzbekcha, Русский, English), then
`<site origin><link>`. The texts are the approved plain texts, only HTML-escaped (`& < >`). 4096 characters for a message,
1024 for a caption, counted in UTF-16 units after parsing. A post over the limit is **refused with a code** (`too_long`,
settled `failed` / `bad_request`), never cut. Other local refusals: `bad_texts`, `bad_link`, `no_origin`, `unsafe_text`
(the words contain something that looks like a key or an address; they are never altered), `bad_media`, `no_media_base`.
Media is fetched by Telegram from `<SUPABASE_URL>/storage/v1/object/public/<media_path>` (public `showcase/` bucket,
`.jpg .jpeg .png` as a photo, `.mp4` as a video; nothing else is sent). No media is ever attached to a news or price post.

**How each answer is settled** (the same classifier as the customer sender, `classify_response`, with one change: whatever
leaves "was it posted?" open is final):

| What happened | Reported to `complete_marketing_post` | Worker |
|---|---|---|
| 200 `ok` | `sent` + message id | |
| 429 | `retry` / `rate_limited` + `retry_after` | pauses `retry_after` (at most 10 min) |
| 401 / 404 (token refused) | `retry` / `not_configured` | ALARM in the log, pauses 5 min, reports `failed` with the remedy |
| connection never established (refused, unresolvable, connect timeout) | `retry` / `network` | the database retries it later |
| 403, 400 "chat not found" | `failed` / `blocked` | the bot was removed or is not an admin |
| other 4xx, or a post that was refused locally | `failed` / `bad_request` | |
| 5xx | `dead` / `http_5xx` | **never retried** (the customer sender retries a 5xx) |
| read timeout, reset, 200 without `ok`, unreadable reply, anything unexpected | `dead` / `unconfirmed` | **never retried** |
| the settle call itself fails, or answers "lease lost" | | logged; the database ends the post as `dead` / `unconfirmed`; **never sent again** |

**The token.** Only from `TELEGRAM_CHANNEL_BOT_TOKEN` (never `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CUSTOMER_BOT_TOKEN`; a
test pins it). It appears only in the request URL held by `TelegramClient`. Log lines carry codes and counts: no exception
text, URL, text, chat or key is logged, and `urllib3`'s own DEBUG line (`POST /bot<token>/sendMessage`) is silenced.
`tests/test_marketing_worker.py` pipes a fake token through every failure path (connection refused, connect and read
timeout, reset, SSL, 4xx, 5xx, unreadable replies, refused posts, the success path) with the redaction net switched off
and asserts no fragment of it appears in any log line, report, result or exception.

**Local runs.** `NOTIFY_TELEGRAM_API_BASE=http://127.0.0.1:8081` points the worker at `tools/fake_telegram.py`
(the customer worker's variable; never set in the deployed env file).

## What the owner does by hand (the worker exists now; nothing runs until you do this)

1. In Telegram, @BotFather, `/newbot`, a name and a username ending in `bot`. Copy the token; paste it nowhere
   except step 3.
2. **Make a throwaway test channel first** and add the new bot as an administrator with only "Post messages". The
   simplest handle is a temporary public username (`@something_test`); a private channel needs its numeric id
   (`-100...`), which a bot such as @getidsbot shows (unverified, not checked here).
3. GitHub, Settings, Secrets and variables, Actions: secret `TELEGRAM_CHANNEL_BOT_TOKEN`; variable
   `MARKETING_TELEGRAM_CHAT` = the **test** channel id from step 2.
4. Set variables `NIGHTSHIFT_MARKETING_WORKER` = `on` and `NIGHTSHIFT_MARKETING_POSTS` = `on`, then run Deploy web.
   The log ends with `marketing-worker after 20s: state=running`. (With only the first variable on, the container
   exists and idles; with neither, there is no container and no env file.)
5. Check the 0107 second-factor gate is on (`select admin_aal2_required from public.owner_security_settings;`).
   Then re-arm the database switch (the Marketing page, "Switch the poster on", or `owner_marketing_kill(false, '<reason>')`)
   **before** approving anything: approving is refused while the poster is off.
6. Approve a draft on the Marketing page (the order is spelled out in "The owner page") and watch it arrive in the **test channel**.
   Check all three blocks, the link and the escaping. Only then change `MARKETING_TELEGRAM_CHAT` to
   `@nightshiftaistudio` and re-run Deploy web. There is deliberately **no "send test" button** (a test would be a
   public post) and no second chat variable in the database contract: the test channel is the same variable pointed
   somewhere private. **A rehearsal is a real send as far as the database knows**: it uses up that draft's idempotency
   key (the real channel will not get that item) and one of the week's two slots (the cap counts sent posts for 7 days).
   Pick the draft you can afford to spend.

To stop: set `NIGHTSHIFT_MARKETING_POSTS` to anything but `on` (the worker idles at once on the next deploy), tap the
kill switch, run `update public.marketing_settings set enabled = false where id;` in the SQL editor, or set
`NIGHTSHIFT_MARKETING_WORKER` to anything but `on` (the container and the file holding the token are removed).

## What the sender does (the notes from review, now built and pinned by tests)

- **Retries.** `rate_limited` (HTTP 429, `retry_after` honoured) and `not_configured` (the token is refused) are reported
  as `retry`: the database does not use up an attempt for either, and the worker pauses on a refused token as
  `notify_worker` does. A refused connection (`network`, nothing was sent) is a `retry` too.
- **Ambiguous answers are `dead`, never `retry`.** `http_5xx`, a read timeout, a dropped connection after the request
  was written, an unparseable reply: Telegram may have posted the message. The database turns any other `retry` code
  into `dead` / `unconfirmed` anyway, and a dead post keeps its weekly slot.
- **Reuses `modules/notify_telegram.py`'s classification** (`classify_response`, `_connect_failed`) instead of a second
  one; `tests/test_channel_post.py` pins the mapping against real sockets: a closed port gives `retry/network`, a server
  that closes after the request, a read timeout, a 5xx and an unreadable 200 give `dead`, each with exactly one request.
- The site origin goes in front of `link` (a path), exactly the approved texts are sent in the fixed three-block order,
  and only to the one configured channel id.

## Promo and custom posts (migration `0110_marketing_promo_custom.sql`, Telegram only, dormant)

Two more kinds, `promo` (drafted by the worker from a reviewed repository file, a later slice) and `custom` (typed by the
owner on the page: the "New post" form, below). The page's **New post** form calls `owner_marketing_create`; **nothing calls
`marketing_draft_upsert_v2` yet** (the worker half of `promo` is a later slice).

- **Same life as news.** Draft, the owner's approval of the exact words (`approved_hash`), the 72 hour expiry, the kill
  switch, the claim. No 0108 function, trigger or the status machine is redefined; the live worker keeps calling the same
  9-argument `marketing_draft_upsert`, `claim_marketing_post` and `complete_marketing_post`.
- **One cap for every kind.** news, price, promo and custom share the 2 posts per rolling 7 days (the owner's decision).
  `marketing_cap_used()` and the approval check count every row, as before.
- **Keys.** `promo:<slug>:telegram` with `source_ref promo:<slug>` (one file, one row per target); `custom:<request id>:telegram`
  with `source_ref owner:<user id>`. The page makes the request id once per "New post" screen, so a double tap or a retry
  returns the same post (`created: false`) and never a second.
- **`owner_marketing_create(p_request_id, p_texts, p_link, p_kind default 'custom')`**: the owner's front door
  (`owner_guard`: platform owner/admin, second factor, a rate limit of 20 per 10 minutes), the same text rules as a draft,
  a link that is a path. It makes a **draft only**; approving is a separate act on the card. `p_kind` may only be `custom`:
  a `promo` row cannot be made by a person through this function. Audited as `marketing.create` (lengths and hash, never the
  words).
- **`marketing_draft_upsert_v2(...)`**: the worker's (service_role only), the same arguments as the 0108 function; it
  accepts `news`, `price` (handed to the 0108 function unchanged) and `promo` (own checks, same freeze rule: a draft a person
  edited is never overwritten). `showcase` and `custom` are refused.
- **Not checked by the database:** `docs/news/banned-claims.json` (a repository file SQL cannot read). The page warns for a
  custom post; the worker blocks for a promo post.
- **The "New post" form (the owner's page).** A button above the posts opens three text boxes (uz, ru, en) with live counters
  (characters of 1000 as the database counts them, UTF-16 units as the sender counts them), an optional link (one of our own
  pages, or another path like `/pricing`), and the same `TelegramPreview` every card uses. Saving goes through a "Create draft?"
  sheet, then `POST /api/marketing` `{action: "create", requestId, texts, link}` -> `owner_marketing_create(..., 'custom')`,
  behind the same switch, same-origin, signed-in owner and second-factor checks as approve and edit. It makes a **draft only**:
  the owner approves on the card, with the hash the page showed, exactly as for news. The `requestId` is made once when the form
  opens and sent with every attempt, so a double tap or a retry is one post (`created: false`); closing the form and opening it
  again is a new post. `promo` and `custom` are known kinds on the card (title, Approve, Edit, Reject); a kind the page does not
  know is still listed as "Other".
- **Banned wording on the page.** The Next app cannot read `docs/news/banned-claims.json`, so `command-center/lib/marketing-banned.ts`
  holds a copy of the rules and provider names (translated to JavaScript regular expressions with a Unicode word boundary).
  `command-center/tests/marketing-banned.test.ts` fails if the copy differs from the JSON by one pattern, and both it and
  `tests/test_marketing_banned_fixture.py` run `tests/fixtures/marketing_banned_cases.json` (made by the Python checker), so the
  two dialects cannot drift apart. The form shows the hits (the rule, in the person's language, and the words found) and repeats
  them in the sheet; it does not block, because the owner decides. A clean result means this list found nothing, not that every
  claim is true. When the JSON changes, copy the change into `lib/marketing-banned.ts`, add a word of copy for a new rule id in
  `lib/i18n/marketing/{en,ru,uz}.ts` (`newPost.banned.rules`), and regenerate the fixture.
- **Merge order.** After 0110 is applied a row of an unknown kind may exist. The page and the operator bot must be tolerant
  of an unknown kind (separate PR) and deployed BEFORE this migration merges: a page that rejects one unknown kind reads the
  whole list as "could not read".
- **Rollback.** `docs/sql/rollback_0110_marketing_promo_custom.sql`. While a promo or custom row exists it leaves the widened
  CHECKs in place (posts are never deleted) and says so.

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
5. ~~Private test channel first?~~ Answered by the hand steps above: point `MARKETING_TELEGRAM_CHAT` at a private channel
   first (no second variable, no change to the database contract).
6. Is Telegram's 1024-character caption limit and 50 MB bot upload limit current? (The 50 MB figure was confirmed in
   the Bot API FAQ; the caption and URL-fetch figures are from memory: unverified. The texts are kept short enough
   to fit a caption in any case.)
