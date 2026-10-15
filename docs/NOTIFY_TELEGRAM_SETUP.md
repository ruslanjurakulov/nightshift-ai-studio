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

## Languages

The language of a chat is a bare language code (two or three letters) stored when
the chat is linked (the language is only a browser cookie today, not on the
account), and changeable in Settings. The sender and the bot look words up by that
code (`COPY` in `modules/notify_telegram.py`, `BOT_COPY` in
`_shared/telegram-notify.ts`) and fall back to English for a code, or a key, that
has no words. Adding a language is adding a key to those two tables and to
`lib/i18n/notify-channels/`; the database accepts any code.

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
6. **Sender, before the switch.** An empty username keeps the panel hidden, so
   nobody can link a chat that nothing would send to. Write the notify worker's own
   env file, `/opt/nightshift/.env.notify` (mode 600), with exactly four names:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_CUSTOMER_BOT_TOKEN` and
   `NOTIFY_APP_ORIGIN=https://<the app>`. It is deliberately not the pipeline
   worker's file, so this container never holds the provider keys. Then
   `docker compose --profile notify up -d notify-worker`. If Telegram ever refuses the
   token (revoked, mistyped) the worker logs an ALARM line, sends and drops nothing,
   and tries again every five minutes.
7. **Web app, last.** Set `TELEGRAM_CUSTOMER_BOT_USERNAME=reply_NightshiftAiStudio_bot`
   in the web container's environment (server-only, read at request time; no
   rebuild). This is the go-live switch: the example files leave it empty on purpose,
   and until it is set the Notifications panel is hidden.
8. **Try it** with your own account: connect, press Start, press Yes, "Send a test
   message". Block the bot and watch the chip turn to Blocked; unblock; `/stop`.
9. **Privacy text.** Done in this change: `lib/legal-docs` (en/ru/uz) has a data line and a
   sub-processor row for Telegram customer notifications. Have it reviewed before go-live.

### Deploy wiring that is not in this PR

The deploy workflow builds `.env.web` and `.env.worker` from allow-lists
(`deploy/.env.web.example`, `deploy/.env.worker.example`), and a test requires every
key there to be mapped in `.github/workflows/deploy_web.yml`. This change may not
edit workflows, so it does **not** add the names to those example files. To deploy
through the pipeline, add in one commit: the keys `TELEGRAM_CUSTOMER_BOT_USERNAME`
(web) to `.env.web.example` with its `WEBENV_` mapping in the workflow, and a step that
writes `/opt/nightshift/.env.notify` (the notify worker's own four names; the token a
secret) and starts `notify-worker` behind a switch (like `NIGHTSHIFT_CREATIVE_WORKER`).
Until then steps 6 and 7 are done by hand on the server. (`deploy/docker-compose.yml` already
passes `TELEGRAM_CUSTOMER_BOT_USERNAME` through to the web container, which a test
requires of every variable the app reads; with the pipeline's env file regenerated on
each deploy, the value must come from the allow-list above.)

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
