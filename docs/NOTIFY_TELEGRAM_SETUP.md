# Telegram notifications for customers (migration 0102)

A person links their own Telegram chat in Settings and then gets a short message
for the events they choose: a video is ready, a storyboard needs their decision,
a generation did not finish, an export is ready, credits are running low (the five
notification kinds of migration 0064). Off and hidden until the owner creates the
customer bot and sets the environment below.

**Merging `supabase/migrations/0102_notification_channels.sql` to main applies it
to the live database automatically.** It is additive and inert until a chat is
linked, but it creates five tables and seventeen functions and adds a trigger on
`notifications`; read it and run its Verify query.

## The pieces

| Piece | Where | Holds |
| --- | --- | --- |
| Tables, functions, fan-out trigger | `supabase/migrations/0102_notification_channels.sql` | links, hashed tokens, preferences, outbox |
| Webhook (link + block/stop signals) | Edge Function `telegram-notify-webhook`, logic in `supabase/functions/_shared/telegram-notify.ts` | the service key, the webhook secret; **not** the bot token |
| Sender | `tools/notify_worker.py` (compose service `notify-worker`, profile `notify`), words in `modules/notify_telegram.py` | the service key, the bot token |
| Settings panel + routes | `components/notifications/NotificationChannels.tsx`, `app/api/notifications/telegram/**` | the person's session only |
| Local fake Telegram | `tools/fake_telegram.py` | nothing leaves the machine |

The Command Center never holds the service key; the browser never sees a chat id
(the column is not readable through the API).

This is **not** the operator bot. The operator bot (`@NightshiftAiStudio_bot`,
`TELEGRAM_BOT_TOKEN`, `tools/run_telegram_control.py`, polled by getUpdates) is not
read, called or changed anywhere here. A bot cannot have both a webhook and
getUpdates, which is one more reason for a separate bot.

Where the operator bot runs is a separate switch with the same shape as the two
here: the repository variable `NIGHTSHIFT_OPERATOR_BOT` = `on` makes *Deploy web*
start the always-on `operator-bot` service (`/opt/nightshift/.env.operator`, its own
file, never this one) and makes the two operator GitHub workflows skip their work,
so only one process ever calls `getUpdates` for that bot. Its secrets and the
one-time order are in `docs/operator-bot.md` ("Always on, on the server"). The
customer bot is unaffected either way.

## How linking works

1. Settings, Notifications, **Connect Telegram**. The database makes a one-time
   token (56 hex characters from the server's CSPRNG; only its SHA-256 is stored;
   10 minutes; single use; 5 an hour per person; one pending per person; at most 3
   chats per person). The app shows `https://t.me/<bot>?start=<token>`.
2. In Telegram the person presses Start. The webhook peeks at the token (without
   using it) and the bot asks "Connect this chat to your account @handle?" with
   Yes / No. The @handle is the visible username of 0096 when the person has one;
   never an e-mail address.
3. Only Yes consumes the token, in one row lock: private chat only, the chat id
   must equal the sender's own user id, the chat must not belong to another
   active account. The page notices the new chat by polling its own channel list.

Telegram signals are honoured from the chat itself: blocking the bot marks the
channel blocked (its queue is dropped, nothing is retried), unblocking re-enables
it, `/stop` pauses, `/resume` resumes.

## Sending rules

* One outbox row per (notification, channel): unique `idempotency_key`, so a
  notification is queued once. A claim is under a 60 s lease; **a claim that is
  lost is never sent again** (it ends as `unconfirmed`): a missed message is
  better than a duplicate. A request that may have been delivered (read timeout,
  reset connection) is not retried either; only a request that never left
  (refused, unresolved, connect timeout) is.
* Retries: 30 s doubling, capped at 1 h, 6 attempts, honouring Telegram's
  `retry_after` (which does not use up an attempt). Nothing older than 24 h is
  sent. HTTP 403 (and "chat not found") blocks the channel: no retry storm.
* Rate: at most 1 message a second per chat and 25 a second overall in the worker;
  at most 30 queued messages per channel per hour (the rest are recorded as
  `skipped`); test messages 3 an hour, links 5 an hour per person.
* Content: one sentence chosen from the notification **kind**, plus one button
  that opens the app section the bell would open. Never a title, prompt, file
  name, amount or provider text. "Your credits were returned" appears only when
  the notification itself carries `credits_returned`.

## Languages (migration 0105)

Both customer channels, the Telegram bot and the e-mails, run in a language the
person chooses: every bot reply and button, the link-flow messages, confirmations,
errors, the notification messages, the e-mail subject and body, the unsubscribe
link and the page it opens. Supported now: `en` (default and fallback), `ru`, `uz`
(Latin). **The Russian and Uzbek wording is a machine draft**: have a native
speaker read `ru.json` and `uz.json` before launch.

**One source of words.** `supabase/functions/_shared/notify-i18n/` holds
`registry.json` (the list of codes, the default, each language's own name) and one
flat `<code>.json` per language, with the key families `meta.*`, `bot.*` (the
webhook), `push.*` (the sender) and `mail.*` (the e-mails). The Edge Function
(`_shared/notify-i18n.ts`) and the Python side (`modules/notify_i18n.py`, used by
`modules/notify_telegram.py` and `modules/email_notify.py`) read the same files, so
there is nothing to keep in step. A code the registry does not list is English, and
a language key missing from a file falls back to English per key.

**Adding a language** is: a `<code>.json` with exactly English's keys and
placeholders, a line in `registry.json`, one import line in `notify-i18n.ts`, the
code in the one-line allow-list `notify_language_ok()` (a new migration with
`create or replace function`; no table or constraint changes), and the app's own
list `LOCALES` in `command-center/lib/i18n/core.ts` with its dictionaries.
`tests/test_notify_i18n.py` and `command-center/tests/notify-i18n.test.ts` fail
until every place agrees, until the files have the same keys and placeholders, if
a Telegram message could pass 4096 characters, and if any code branches on a
particular language (`if lang == "ru"` and its cousins).

**Telegram.** The language is per chat: `notification_channels.locale`, set from the
language the person was using when they pressed Connect, changeable in Settings
(per chat) or in the chat itself with `/language` (inline buttons, one per
registered language, each in its own name). The change moves the chat's still
waiting messages to the new language too. A linked chat is always answered in its
own language, an unlinked one in Telegram's `language_code` when the bot has words
for it, else English. `/language` only ever changes the channel linked to the chat
that sent it.

**E-mail.** `email_preferences.locale`. Until the person picks one in Settings, the
Notifications page (E-mail language) it is the language the app reports it is
shown in; once picked, that report no longer changes it (`locale_chosen`). The
unsubscribe link carries the language the mail was written in, and the page uses
it, else the visitor's own.

**Not localized (by design).** Anything sent without a database row to read a
language from stays English: pipeline pushes and operator alerts (the operator bot
has its own languages), and the notification titles inside the app's bell, which
follow the browser's language as before.

The language is validated against the allow-list in the database (`notify_language_ok`,
checked by every locale column and every function that takes a language), in the
API routes and in the bot, and is never put into a path, a URL or HTML unchecked.

## Going live: the owner's steps

Nothing below is a secret in the repository. Values go only where named.

1. **Create the bot.** In @BotFather: `/newbot`, username
   `reply_NightshiftAiStudio_bot` (already chosen; public). Keep the token.
2. **Apply the migration** (merge to main, or run the file in the SQL editor), then
   run its Verify query: every column must read `true`.
3. **Webhook secret.** Make a long random string of `A-Z a-z 0-9 _ -` (24 to 256
   characters). Store it as the Supabase secret `TELEGRAM_CUSTOMER_WEBHOOK_SECRET`.
4. **Deploy the Edge Function:**
   `supabase functions deploy telegram-notify-webhook --no-verify-jwt`
5. **Point Telegram at it, once**, from a shell where the two values are in the
   environment (do not paste them anywhere else):
   ```
   curl -sS "https://api.telegram.org/bot${TELEGRAM_CUSTOMER_BOT_TOKEN}/setWebhook" \
     --data-urlencode "url=https://<project-ref>.supabase.co/functions/v1/telegram-notify-webhook" \
     --data-urlencode "secret_token=${TELEGRAM_CUSTOMER_WEBHOOK_SECRET}" \
     --data-urlencode 'allowed_updates=["message","callback_query","my_chat_member"]'
   ```
   Check with `getWebhookInfo` (same bot token): `url` set, no `last_error_message`.
6. **Sender, before the switch.** The deploy does this for you; see "Going live
   without a computer" below. It writes the notify worker's own env file,
   `/opt/nightshift/.env.notify` (mode 600), with exactly four names:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_CUSTOMER_BOT_TOKEN` and
   `NOTIFY_APP_ORIGIN=https://<the app>`, and starts `notify-worker`. It is
   deliberately not the pipeline worker's file, so this container never holds the
   provider keys. If Telegram ever refuses the token (revoked, mistyped) the
   worker logs an ALARM line, sends and drops nothing, and tries again every five
   minutes. By hand on the server it would be
   `docker compose --profile notify up -d notify-worker`.
7. **Web app, last.** The deploy sets `TELEGRAM_CUSTOMER_BOT_USERNAME` in the web
   container's environment from the GitHub variable of that name (server-only,
   read at request time; no rebuild). This is the go-live switch: it is empty
   until you set the variable, and until then the Notifications panel is hidden,
   so nobody can link a chat that nothing would send to.
8. **Try it** with your own account: connect, press Start, press Yes, "Send a test
   message". Block the bot and watch the chip turn to Blocked; unblock; `/stop`.
9. **Privacy text.** Done in this change: `lib/legal-docs` (en/ru/uz) has a data line and a
   sub-processor row for Telegram customer notifications. Have it reviewed before go-live.

### Going live without a computer (the deploy does steps 6 and 7)

`.github/workflows/deploy_web.yml` (the existing "Deploy web" workflow, same
triggers and permissions) now does the server side of steps 6 and 7 on every
deploy. You only create GitHub settings; nobody needs a shell on the server.

What a deploy does:

* **`NIGHTSHIFT_NOTIFY_WORKER` is `on`:** after the web app is healthy it writes
  `/opt/nightshift/.env.notify` (mode 600, four names, nothing else) and runs
  `docker compose --profile notify up -d --build --no-deps notify-worker`. The log
  ends with a line like `notify-worker after 20s: state=running exit=0
  restarts=0 oom=false` (numbers only, never log text). It is independent of
  `NIGHTSHIFT_WORKER`: the pipeline worker does not have to be on, and does not
  receive the bot token. A missing secret fails the deploy with the name of the
  missing key (`::error::TELEGRAM_CUSTOMER_BOT_TOKEN is required and empty ...`).
* **`NIGHTSHIFT_NOTIFY_WORKER` is anything else, or not set (the default):** no
  env file is written, `notify-worker` is stopped and removed, and
  `/opt/nightshift/.env.notify` is deleted if it exists. The rest of the deploy is
  exactly what it was.
* **`TELEGRAM_CUSTOMER_BOT_USERNAME`** is mapped into the web env like every other
  key of `deploy/.env.web.example` (a test requires every key there to be mapped
  in the workflow). Empty or not set: the panel stays hidden.

The env file is built from named GitHub settings only (`deploy/build-service-env.py`,
`deploy/.env.notify.example` is the allow-list the server checks it against); the
pipeline provider keys are not in that step at all, and the bot token is not in
`.env.web` or `.env.worker`.

**The names to create** in GitHub, Settings, Secrets and variables, Actions
(repository level):

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TELEGRAM_CUSTOMER_BOT_TOKEN` | the token from @BotFather (new) |
| Secret | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | already there (the bot and the pipeline worker use them); add them if you never did |
| Variable | `NIGHTSHIFT_NOTIFY_WORKER` | `on` (the switch; anything else or unset = off) |
| Variable | `NOTIFY_APP_ORIGIN` | optional, `https://<the app>` with no path; empty = `https://<DOMAIN>` (the `DOMAIN` variable, else `new.nightshift-ai.studio`) |
| Variable | `TELEGRAM_CUSTOMER_BOT_USERNAME` | `reply_NightshiftAiStudio_bot`, no `@` (the go-live switch; **last**) |

**The order:**

1. Merge this change and let the "Deploy web" run finish green (the server's
   deploy script has to be the new one before the switch exists).
2. Secret `TELEGRAM_CUSTOMER_BOT_TOKEN`; variable `NOTIFY_APP_ORIGIN` if the app is
   not served on `DOMAIN`; then variable `NIGHTSHIFT_NOTIFY_WORKER` = `on`.
3. Actions, **Deploy web**, **Run workflow**. In the log look for
   `notify-worker after 20s: state=running ... restarts=0`. Check
   `getWebhookInfo` (step 5) too. Nothing is visible to customers yet.
4. **Last:** variable `TELEGRAM_CUSTOMER_BOT_USERNAME`, then **Run workflow** again.
   The Notifications panel appears in Settings. Step 8 is your own test.

To take it down: delete the username variable (or empty it) and run the workflow
(the panel is hidden again), then set `NIGHTSHIFT_NOTIFY_WORKER` to anything but
`on` and run it again (the sender and its file are removed).

### Customer e-mails (migration 0103): wired the same way

`tools/email_worker.py` (Resend) is a separate process with its own environment
names, so it has its own service, `email-worker` (profile `email`), its own env
file `/opt/nightshift/.env.email` (mode 600, five names: `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `NIGHTSHIFT_EMAIL_FROM`, `APP_ORIGIN`)
and its own switch. Not the pipeline worker's file, not the notify worker's: it
never holds the provider keys or the Telegram token, and they never hold the mail
key. The transport is fixed to `resend` in `deploy/docker-compose.yml`, so a deploy
cannot start it on the `fake` one. Default off, behaving exactly like the notify
worker above:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `RESEND_API_KEY` | the Resend key (the operator alert mail uses the same name) |
| Secret | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | as above |
| Variable | `NIGHTSHIFT_EMAIL_FROM` | the sender, e.g. `Nightshift <hello@your-domain>`, a domain verified in Resend |
| Variable | `NOTIFY_APP_ORIGIN` | optional, as above (the e-mail worker reads it as `APP_ORIGIN`) |
| Variable | `NIGHTSHIFT_EMAIL_WORKER` | `on` (the switch) |

There is no separate go-live variable: the worker reports to `worker_status` and
the e-mail switches in Settings are shown only while it does
(`email_worker_online()`), so starting the worker is what makes e-mail visible.
Apply migration 0103 first, then set the secret and the two variables, then
`NIGHTSHIFT_EMAIL_WORKER` = `on` last, and run **Deploy web**.

## Running it locally with no Telegram

```
python tools/fake_telegram.py 8081 &
NOTIFY_TELEGRAM_API_BASE=http://127.0.0.1:8081 TELEGRAM_CUSTOMER_BOT_TOKEN=local \
  NOTIFY_APP_ORIGIN=http://localhost:3000 SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
  python tools/notify_worker.py --once
curl http://127.0.0.1:8081/__sent
```
A chat id ending in 403, 429, 500 or 400 makes the fake answer like Telegram does
for a blocked bot, a rate limit, a server error and an unknown chat. The tests use
the same fake (and a fake HTTP session that refuses the real host).

## Decisions taken without the owner (C11 of the design), to overrule

| # | Open decision | Default taken |
| - | - | - |
| 1 | Which events by default | All five on for Telegram once a chat is linked (a missing preference row means on); each is a switch. Email: not part of this change; the preference table is channel-generic so email reuses it, default off. |
| 2 | Titles in messenger text | Never. A sentence and a link only. |
| 3 | The word "Telegram" in customer copy | Allowed, as the name of the channel being linked. No other messenger or provider name. |
| 4 | Email provider and sender | Not built here (another branch). |
| 5 | Confirm step in the bot, masked e-mail | Confirm step: yes (Yes / No buttons). Account label shown: the @username when the person has one, otherwise nothing; never an e-mail, masked or not. |
| 6 | Quiet hours | None. Messages are sent when they happen, including credits low. |
| 7 | Bot name | `reply_NightshiftAiStudio_bot`, as given by the owner. |
| 8 | WhatsApp | No-go for now; nothing built (see below). |
| 9 | Consent wording | One line under Connect ("we send short alerts to this Telegram chat; disconnect any time"), en/ru/uz. Needs the owner's or a lawyer's review. |
| - | Chats per person | At most 3. |
| - | Disconnect | Deletes the row and its queued messages (no soft delete). |
| - | Link bell notification "a chat was connected" | Not added (it would change `notifications_kind_check`); the in-chat confirm step is the guard. |

## Overlap with the email branch (`claude/retention-notify`)

Read at its tip when this was written (still work in progress, migration
`0101_retention_notify.sql`; this one is therefore **0102**, applied after it):

* **Numbering.** Theirs is 0101, mine 0102. Neither replaces the other's functions.
* **The new kind.** It adds `notifications.kind = 'video_ready'` (and replaces
  `notify_storyboard_ready` to carry `channel_id`). This change already knows
  `video_ready`: it is in `notification_pref_event_ok`, the outbox check, the
  sender's words (`COPY`) and link (`/videos/<id>`), and the Settings copy. Nothing
  writes that kind until their migration is applied, and the Settings switch list
  is the app's `NOTIFICATION_KINDS`, so the switch appears when their TypeScript
  adds the kind.
* **Preferences.** They keep a per-person `email_preferences` row (ready e-mail
  on/off, weekly frequency, a language code, an unsubscribe token). This change adds
  the event x channel grid `notification_preferences` (`channel_kind` allows
  `'email'`). The two do not collide: if e-mail later wants per-event switches it
  uses the grid; the one place a default lives is `notification_pref_default()`.
* **Language.** They store the language code the person last used for e-mail; this
  change stores one per chat when it is linked. Both are bare codes with an English
  fallback. If the account later stores a language, both can read it.
* **Files both touch** (expect trivial conflicts, keep both sides):
  `lib/notifications.ts` (kinds), `lib/i18n/{en,ru,uz}.ts` (one key each),
  `tests/security/sec_expectations.py`, `sec_scenario.py`, the Settings page.

## How WhatsApp would extend this (not built)

The same shape: a `whatsapp` value in `notification_channels.kind` (widen the check),
a one-time token carried by a click-to-chat message (`wa.me/<number>?text=<token>`)
so the person's own message opens the 24-hour window and proves the number, a
webhook Edge Function that verifies `X-Hub-Signature-256` with the same constant-time
compare and handles STOP, an `external_id` kept in Vault rather than in the clear,
and approved utility templates per language in the sender (outside the window only
templates may be sent). It needs the owner's Meta business account, verification
and a per-message budget first. See `out/notification-channels-design-2026-10-11.md`.
