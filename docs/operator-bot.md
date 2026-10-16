# Operator bot (@NightshiftAiStudio_bot)

The owner's control panel in Telegram: ask the system how it is, get told when
something needs you, tap instead of type. It is **read-only by default** and it
**cannot publish, spend credits, change prices or plans, grant roles, delete data
or approve anything**. Those stay behind the publish gate and the human
approvals. The old `/publish`, `/pause` and `/resume` still only produce
*intents* that are recorded for the normal gated path; nothing here executes them.

This is the OPERATOR bot. The customer bot (`@reply_NightshiftAiStudio_bot`,
per-user notifications) is a separate feature with its own token and variables
(`TELEGRAM_CUSTOMER_*`); nothing here reads or reuses them. The one shared piece
is the small neutral helper `modules/tg_text.py` (message splitting, escaping, an
outgoing-text scrub), which the customer bot may adopt instead of carrying its own.

## Commands

Everything below also exists as a button in the main menu (`/menu`, `/start`).

| Command | Answers |
|---|---|
| `/health` | site up check of the public pages, each worker's state and heartbeat age, last deploy and CI result, a note that disk space is not reported |
| `/queue` | running and queued render jobs and creative jobs with ages; STUCK marked |
| `/errors` | failures in the last 24 hours, grouped (by channel, by error code, by pipeline event); ids and codes only |
| `/balance` | the latest provider balance snapshot per provider (ElevenLabs credits, Leonardo tokens), with the LOW flag for ElevenLabs |
| `/spend` | provider cost today and over 7 days (recorded estimates); credits captured. A figure built from rows that were not all priced says "at least", never a total |
| `/today` | videos made / published / held / blocked / failed, jobs, new accounts: counts |
| `/users` | new sign-ups in 24 h / 7 d / 30 d: counts only, no names, no e-mails |
| `/deploys` | the last runs of the deploy, tests and frontend workflows on `main` |
| `/approvals` | publish approvals waiting for a person, runs at human approval, held videos; deep link to the app |
| `/security` | recent security-relevant audit events (action and target id; no actor) |
| `/digest` | the daily summary, now |
| `/alerts` | quiet hours, digest hour, hourly limit, what is muted, the last alerts sent |
| `/language [en\|ru\|uz]` | show or change the language the bot speaks (see Language) |
| `/status` `/channels` `/pending` | the original commands, unchanged |
| `/mute [kind\|all]` `/unmute [kind\|all]` | silence alerts for 24 hours (the one safe write: it changes nothing but what you are told) |
| `/publish <id>` `/pause <id>` `/resume <id>` | requests only, through the original intent path; the publish gate still decides |
| `/help` `/menu` | the list, the buttons |

Where the app has the page, a message carries an **Open** button straight to it
(`/{channel}/approvals`, `/errors`, `/jobs`, `/billing`, `/margin`, `/audit`,
`/integrations`, the GitHub deploy page). Without `OPERATOR_APP_URL` there are no
links: a link is never guessed.

## Language

The whole bot speaks one language at a time: **English** (the default), **Русский**
or **Oʻzbekcha** (Latin script). Every command reply, the menu and its buttons, the
button toasts, refusals and errors, the mute confirmations, the quiet-hours and
digest settings text, the proactive alerts and the daily digest follow it. An
unknown language code means English.

**Switch:** send `/language` (it shows the current language and three buttons, each
named in its own language: English, Русский, Oʻzbekcha) or `/language ru` /
`/language uz` / `/language en`. The same three buttons sit at the bottom of the
menu and of `/help`. Telegram's own button strings are not touched.

**Where it is kept:** one row of the existing alert feed, `kind = operator.language`,
`title = <code>`, written with `channel_id` NULL, read only from `channel_id IS NULL`
rows. (Anyone who can see a channel can insert alert rows carrying that channel's
`channel_id` and any kind, so a forged language row, like a forged mute, is ignored
because it is channel-bound. A row with a NULL channel can only be written by a
platform admin or the service key; should such a row ever come from an org member
anyway, the most it can do is change the bot's language, which is cosmetic: the
read keeps only titles that are a supported language code, ignores rows dated in
the future, and the owner's next `/language` is newer than any of them.) No migration. Until the owner
chooses, `OPERATOR_LANGUAGE` (`en`, `ru` or `uz`; a repository variable) is the
default, then English. A stranger is always answered in that default, never in the
owner's stored choice, and the language is read only after the sender has been
authorized.

The language changes only words. Authorization, the intents, the publish gate, the
alert keys (so a language change never re-sends an alert), callback data, ids,
codes, event names, ages (`3m`, `2h 5m`), numbers (`1,234`) and dates (ISO) are the
same in every language.

| Command | English | Русский | Oʻzbekcha |
|---|---|---|---|
| `/health` | Health | Здоровье | Salomatlik |
| `/queue` | Queue | Очередь | Navbat |
| `/errors` | Errors | Ошибки | Xatolar |
| `/balance` | Balance | Баланс | Balans |
| `/spend` | Spend | Расходы | Xarajatlar |
| `/today` | Today | Сегодня | Bugun |
| `/users` | Users | Пользователи | Foydalanuvchilar |
| `/deploys` | Deploys | Деплои | Deploylar |
| `/approvals` | Approvals | Согласования | Tasdiqlar |
| `/security` | Security | Безопасность | Xavfsizlik |
| `/digest` | Digest | Сводка | Xulosa |
| `/alerts` | Alerts | Оповещения | Ogohlantirishlar |
| `/status` | Status | Статус | Holat |
| `/channels` | Channels | Каналы | Kanallar |
| `/pending` | Held | Удержанные | Ushlanganlar |

(The command names you type are the same in every language; the table is what the
menu button and the message heading say.)

**Not covered by the setting:** the two texts the pipeline itself pushes to the chat
without the bot running (the per-event notifications and the six-hourly "runs
pending human approval" nudge from `check_pending_approvals`) are written by jobs
that have no database access, so they stay English.

**Adding a language** is data only: copy `modules/operator_bot/copy_data/en.py` to
`<code>.py`, translate the values, and add the code to the one constant
`LANGUAGES` in `modules/operator_bot/i18n.py`. `tests/test_operator_bot_language.py`
then insists on the same keys and the same `{placeholders}` as English, that
nothing exceeds 4096 characters, that dynamic text is escaped and scrubbed like
English, and (for Uzbek) the site's apostrophe spelling.

### What is real and what is unknown

A source that cannot answer says so ("unknown (not configured)", "unknown
(not set up yet)", "unknown (unavailable)"); it is never shown as zero.

* **Revenue in USD is not shown.** The margin report (`operator_margin_report`,
  0063) is platform-admin only and cannot be called with the service key; the
  bot would need a migration to read it, and it adds none. `/spend` shows cost and
  credits captured and links to the Margin page.
* **Disk space is not reported by the workers** (they send state and heartbeat
  only), so `/health` says so instead of guessing.
* **Role changes and webhook signature failures are not alerted**: nothing writes
  them to the audit log today. The security alert covers the audit actions that
  exist AND are performed by the platform operator (`secret.write`,
  `variable.write`, `billing.settings`, `model.availability`) and any `role.*` /
  `member.*` action the day one is logged. Customer-triggered actions
  (`api_key.*`, `mcp.*`, `api.*`, `channel.youtube.disconnect`) are ordinary tenant
  activity, not alerts, and rows about a customer's channel are ignored.
* **Low balance** uses the one threshold that already exists,
  `ELEVENLABS_LOW_CREDITS` (default 15000), the same line the Billing page uses. No
  other provider and no platform-credit threshold exists, so none is invented.
* **"Made" videos** are `render.completed` events in the mirrored event log; a
  run that never mirrored its events is not counted.
* Sign-ups are counted as organizations created (each sign-up creates one).

## Alerts

`tools/run_operator_alerts.py` runs every 10 minutes (`operator_alerts.yml`; on the
server the service runs the same pass every 5, see "Always on, on the server"),
looks at the same sources, and sends what is new. Each alert has three buttons:
**Open**, **Mute 24h**, **Details** (runs the matching command).

| Kind | Fires when | Severity | Repeats |
|---|---|---|---|
| `run` | a render job failed (12 h window); 3+ creative jobs with the same error code failed within an hour | warn | once per job; the burst every 3 h |
| `stuck` | a running job has no heartbeat for 10 min (the database's own "abandoned" line); a job queued longer than `OPERATOR_STUCK_MINUTES` | warn | every 6 h while it lasts |
| `balance` | ElevenLabs credits below `ELEVENLABS_LOW_CREDITS` | warn | every 12 h while it lasts |
| `deploy` | the latest finished `deploy_web.yml`, `tests.yml` or `frontend.yml` run on `main` failed | warn | once per run |
| `worker` | a worker said running/starting but has not reported for 5 min (and no fresh worker of that kind exists); a worker reported FAILED | **critical** | every 3 h while it lasts |
| `approval` | a new pending publish approval | info | once |
| `audit` | an operator-level audit event with no channel (see above) | **critical** | once |

Restraint, so it never spams:

* **De-duplicated.** Each alert has a key; a key already sent is not sent again
  (one-offs for the 48 hours the memory covers, standing conditions until their
  repeat time above).
* **Rate-limited.** At most `OPERATOR_ALERT_MAX_PER_HOUR` (default 6) non-critical
  alerts an hour, and separately at most 20 critical ones, so a flood of one kind
  cannot starve the other and neither is unlimited; the rest wait for the next
  hour and the message says how many. Alerts of one kind in one pass are merged
  into one message.
* **Quiet hours** (`OPERATOR_QUIET_HOURS`, e.g. `23-7`, in `OPERATOR_TZ`): only
  critical alerts go out. The others are held, not dropped, and are sent after.
* **Mute.** *Mute 24h* (or `/mute <kind>`) silences one kind at every severity.
  `/mute all` silences everything EXCEPT critical alerts (it says so), so a blanket
  mute cannot hide a dead worker or a security event. Alerts that arrive muted are
  marked seen, so a mute ending is not a flood. A mute lasts at most 24 hours. The
  daily digest is not an alert and is not muted.
* **First run is silent.** It announces "Operator alerts are on" once and marks
  what already exists as seen.
* **No memory, no message.** If the alert memory cannot be read, nothing is sent.
* **Daily digest** from `OPERATOR_DIGEST_HOUR` (local), once a day, never in quiet
  hours: a digest hour inside the quiet window goes out when the window ends.

Alert text is ids, counts and fixed words: a failed job is "Render job #123 failed
— default", never its log. The memory is rows of the existing `alert_events` feed
(`kind` starts `operator.`), so **there is no migration**. Every such row is written
with `channel_id` NULL (only a platform admin or the service key can write those)
and the bot reads only `channel_id IS NULL` rows, because the table's insert policy
lets anyone who can see a channel insert rows with that channel and any kind: a
tenant who forges an `operator.mute` or `operator.alert` row changes nothing the
bot believes, and a customer never sees the operator's alerts on their page.
Mutes are capped at 24 hours inside the reader too.

A read that hits its row limit says so ("list cut at N rows: a floor, not the
whole"). Queued and running jobs are read oldest first, separately from the
recently finished ones, so a stuck job is never the row a cut drops. If the alert
memory ever exceeds what the bot reads (5,000 rows in 48 hours) it sends nothing
rather than repeat itself.

## Safety

* Authorization is by the **sender** (`from.id`) on the allow-list, writing in the
  **admin chat**, as before. It now covers every command and every button. Refused,
  silently or with a neutral line: an unknown sender, a group member off the list,
  an allow-listed person in another chat, a channel post, an edited message, a
  forwarded message, a message via a bot or from a bot, a button pressed from
  another chat or with no message attached.
* A stranger's command gets "Not authorized." at most once per ten minutes per
  chat; plain text from a stranger gets nothing.
* A sender is limited to 12 commands a minute (buttons included); the excess is
  dropped after one "Slow down".
* Replies are scrubbed (`modules/log_redaction.py` and `modules/tg_text.py`: token
  URLs, e-mail addresses, bearer/JWT/key shapes), HTML-escaped, and split under
  4096 characters. No raw exception text reaches the chat.
* Reads select no person's words (no job `error`/`params`, no topic, no e-mail, no
  audit actor): ids, statuses, counts and short codes, plus a failed worker's own
  scrubbed `detail` line and an audit row's `target`, both clipped and escaped.
* Nothing in a browser or the bot publishes, re-renders or spends; the bot holds the
  service key only where the poller and alert jobs already did.
* The poller restores the pipeline's `history/` cache READ-ONLY and keeps the Telegram
  offset under its own `telegram-offset-` cache key, so running every five minutes
  can never overwrite the history the video run depends on.
* A command addressed to another bot (`/health@OtherBot`) is ignored.

## Go-live: what the owner does

Nothing here is applied until this PR is merged (scheduled workflows run from
`main`). There is **no SQL**.

1. **Secrets already in place** (same names as before): `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. In a private chat
   with the bot, `TELEGRAM_CHAT_ID` is your user id and nothing else is needed. For
   a group chat also set the secret `TELEGRAM_ADMIN_USER_IDS` (comma-separated user
   ids); until then nobody in the group can command.
2. **Optional repository variables** (Settings > Secrets and variables > Actions >
   Variables): `OPERATOR_APP_URL` (e.g. `https://nightshift-ai.studio`, for the Open
   buttons and the site check), `OPERATOR_TZ` (e.g. `Asia/Tashkent`),
   `OPERATOR_LANGUAGE` (`en`, `ru` or `uz`), `OPERATOR_QUIET_HOURS` (e.g. `23-7`),
   `OPERATOR_DIGEST_HOUR` (e.g. `9`),
   `OPERATOR_STUCK_MINUTES`, `OPERATOR_ALERT_MAX_PER_HOUR`, and the existing
   `ELEVENLABS_LOW_CREDITS`.
3. **Merge the PR.** Then, once: Actions > *Operator Alerts* > Run workflow, tick
   "Also send the daily digest right now". You should get the digest and, on the
   first run, "Operator alerts are on".
4. Send `/start` to the bot and tap through the menu.
5. The poller now long-polls for about 4.5 minutes per run, every 5 minutes: while
   a run is live the reply arrives in a second or two; in the gap between runs it
   waits for the next one. GitHub only fires that schedule every few hours in
   practice: for an answer at any hour use the always-on service below ("Always on,
   on the server"). To return to the old behaviour set the cron in
   `telegram_control.yml` back to `*/15` and the `--duration` to 0.

The workflow tokens are least-privilege: `contents: read` plus `actions: read`
(read-only run status for `/deploys`); no write scope anywhere.

## Always on, on the server (recommended)

GitHub's `schedule` is best effort. The `*/5` poller and the `*/10` alert pass were
observed to fire only every three to five **hours**, so commands were answered hours
late and alerts and the digest arrived late. The same server that runs the dashboard
can run the bot as a service that never stops: `tools/operator_bot_service.py`, the
compose service `operator-bot` (profile `operator`).

* The main thread long-polls Telegram continuously (`getUpdates`, 25 s per call), so a
  reply goes out within a second or two, around the clock. It uses the same code as
  the workflow (`tools/run_telegram_control.py` `poll_once` and the router).
* A second thread runs the alert and digest pass (`AlertEngine.tick`, the code
  `tools/run_operator_alerts.py` runs) every `OPERATOR_ALERT_INTERVAL_SECONDS`
  (default 300; 600 when there is no GitHub token, because the unauthenticated GitHub
  API allows 60 requests an hour; 60 to 3600 allowed). Dedupe keys, cooldowns, mutes,
  quiet hours, the hourly budget, the digest date and the language are the same
  because they live in the engine and its store, not in the scheduler. Being a
  thread, a slow pass never delays a reply.
* It restarts on failure (`restart: unless-stopped`). Telegram refusing the poll with
  **409** (a webhook is set, or a second consumer exists) or **401** (a bad token)
  cannot be fixed by retrying, so the process logs one line and **exits with code 1**;
  docker restarts it with a growing delay and `docker ps` shows it restarting. Any
  other failure (network, a 5xx) is retried after 2, 4, ... 30 seconds and never ends
  the process.
* **State: none on the server.** Alert memory, mutes, the digest date and the language
  are `alert_events` `operator.*` rows, and every update is claimed by its `update_id`
  in `telegram_updates` before it is handled, exactly as in the workflows. What the
  workflows kept in the Actions cache has this equivalent: the *getUpdates offset* is
  held in memory (after a restart Telegram redelivers only what it never saw
  confirmed, at most the last batch, and the claims skip what was already handled, so
  nothing is answered or run twice); the *pipeline history* (`chronos.db`) is not
  restored, so `/status` says "unavailable" and the held-for-review count is left out
  of `/approvals` and the digest, and `/pending` says it could not read. Every other
  view reads Supabase and answers as before.
* It listens on **no port**, has no Caddy route and is not the webhook server: it
  only calls out (`api.telegram.org`, Supabase, `api.github.com`). The container runs
  as uid 1000 with `cap_drop: ALL`, `no-new-privileges`, no volume and no docker
  socket, with its own env file `/opt/nightshift/.env.operator` (mode 600) of exactly
  the names in `deploy/.env.operator.example` - never a pipeline provider key.

### The switch

One GitHub **repository variable**, `NIGHTSHIFT_OPERATOR_BOT`. Anything but `on`
(unset, `off`) is the default and changes nothing: the two workflows run as before,
and a stray `operator-bot` container or `.env.operator` is removed by the next deploy.

With `on`, the next *Deploy web* run

1. checks, **before it touches SSH**, that `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set (it names the missing key, never
   a value);
2. writes `/opt/nightshift/.env.operator` (600) and starts `operator-bot` on the image
   it just built (`docker compose --profile operator up -d --build --no-deps operator-bot`);
3. prints `operator-bot after 20s: state=running exit=0 restarts=0 oom=false`.

**While it is `on`, `telegram_control.yml` and `operator_alerts.yml` skip their job**
(`if: vars.NIGHTSHIFT_OPERATOR_BOT != 'on'`), including a manual run. Telegram
allows ONE `getUpdates` consumer, so this is what prevents a 409 between the server
and a workflow. Use the bot's `/digest` command instead of the *Run workflow* digest
checkbox.

What the deploy reads (the same secrets and variables the workflows use):

| Kind | Name | |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | required |
| Secret | `TELEGRAM_ADMIN_USER_IDS` | optional, group chats only |
| Secret | `OPERATOR_GITHUB_TOKEN` | optional: a fine-grained, **read-only** token for this repository with only *Actions: read*. It becomes `GITHUB_TOKEN` in the container (GitHub reserves that name for secrets) and feeds `/deploys`, `/health` and the failed-deploy alert. The server has no job token, so without it the public API is used anonymously (rate-limited, the alert pass slows to 10 minutes) and a refused answer shows "unavailable" for that line only. Never reuse `GH_SECRETS_TOKEN`, which can write secrets. |
| Variable | `OPERATOR_LANGUAGE`, `OPERATOR_TZ`, `OPERATOR_QUIET_HOURS`, `OPERATOR_DIGEST_HOUR`, `OPERATOR_STUCK_MINUTES`, `OPERATOR_ALERT_MAX_PER_HOUR`, `OPERATOR_APP_URL`, `ELEVENLABS_LOW_CREDITS` | optional, as above |

### One-time order

1. Merge this change and let *Deploy web* run once with the variable unset (the server
   learns the new deploy script; nothing else changes).
2. Make sure the four required secrets exist (they do if the workflows already work).
   Optionally add `OPERATOR_GITHUB_TOKEN`.
3. Set the variable `NIGHTSHIFT_OPERATOR_BOT` = `on` (Settings > Secrets and variables
   > Actions > Variables).
4. Actions > *Deploy web* > Run workflow. In its log look for
   `operator-bot after 20s: state=running`.
5. Send `/start` to the bot. The reply should arrive in a second or two, at any hour.

If a workflow poll was running at the moment of step 4 (they last up to 4.5 minutes),
the service gets a 409, exits and is restarted by docker; it settles on its own as soon
as that run ends. If it keeps restarting, `exit=1` plus the log hint
`a_webhook_is_set` means a webhook is registered (`tools/operator_bot_server.py
delete-webhook`) and `rejected_the_bot_token` means `TELEGRAM_BOT_TOKEN` is wrong.
On the server: `dc logs --tail 50 operator-bot`.

To go back, set the variable to anything else (or delete it) and run *Deploy web*: the
container and `.env.operator` are removed and the workflows resume on their next tick.

## Faster than polling: webhook mode (optional, needs a host)

`tools/operator_bot_server.py` answers within a fraction of a second. Polling (the
always-on service above, or the scheduled workflow) keeps working unchanged and is
what runs until you do this; do not run the webhook next to the service, a set webhook
makes the service exit with 409. **The repository's automatic
deploy does not start it**: that would need `deploy_web.yml` (and, for a route on
the main domain, the pinned Caddyfile hash in `deploy/remote-deploy.sh`) to change,
which this PR deliberately does not do. Run it on a host you control that is
reachable over HTTPS:

1. Create the secret: a random string of 16-256 characters from `A-Za-z0-9_-`
   (`python -c "import secrets;print(secrets.token_urlsafe(32))"`). Put it only in
   the server's env file as `TELEGRAM_WEBHOOK_SECRET`.
2. The env file holds `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TELEGRAM_ADMIN_USER_IDS` (if a group), `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `GITHUB_TOKEN` + `GITHUB_REPOSITORY` (optional, for
   `/deploys`) and the `OPERATOR_*` settings.
3. Start it from the worker image (it has everything it needs):
   `docker run -d --name operator-bot --restart unless-stopped --env-file <env file>
   -p 127.0.0.1:8089:8089 nightshift-worker:latest python tools/operator_bot_server.py
   serve --host 0.0.0.0 --port 8089`
4. Put an HTTPS reverse proxy in front that forwards exactly `POST
   /telegram/operator` to that port (Caddy on the host: `handle /telegram/operator {
   reverse_proxy 127.0.0.1:8089 }` in a site block that has a certificate; a proxy
   inside Docker must instead be pointed at the container, e.g. on a shared network).
   Telegram only accepts HTTPS on ports 443, 80, 88 and 8443.
5. Register it: `python tools/operator_bot_server.py set-webhook --url
   https://<your host>/telegram/operator` (the secret is read from the environment,
   never from the command line). `... info` shows whether it is set and how many
   updates are pending.
6. **While a webhook is set Telegram refuses polling** (HTTP 409). The scheduled
   poller recognises that (and a rejected token, HTTP 401), logs one clear line
   ("a webhook is set for this bot ...") and stops that run at once instead of
   retrying for its whole window; every later run does the same. To go back:
   `... delete-webhook`.

What the endpoint does, in order: the method and path, the
`X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (constant
time; an unset secret refuses everything), the body size, then the **sender
allow-list before any database write or data read**; only then the durable claim of
the `update_id` and the same router polling uses. A stranger's update costs a hash
comparison and gets an empty 200.

## Where things live

| Piece | File |
|---|---|
| Authorization, legacy commands, intents | `modules/telegram_control.py` |
| Update router (poll and webhook share it) | `modules/operator_bot/router.py` |
| Messages and keyboards | `modules/operator_bot/views.py` |
| Words, per language (data only) | `modules/operator_bot/i18n.py`, `copy_data/{en,ru,uz}.py` |
| What is read, and how it is read | `modules/operator_bot/sources.py`, `analysis.py` |
| Alerts, digest, mute | `modules/operator_bot/alerts.py`, `store.py` |
| Webhook handler | `modules/operator_bot/webhook.py`, `tools/operator_bot_server.py` |
| Neutral text helpers | `modules/tg_text.py` |
| Polling runner / alert runner | `tools/run_telegram_control.py`, `tools/run_operator_alerts.py` |
| Always-on service (poll thread + alert timer) | `tools/operator_bot_service.py`, compose service `operator-bot` in `deploy/docker-compose.yml`, env `deploy/.env.operator.example` |
| Workflows | `.github/workflows/telegram_control.yml`, `operator_alerts.yml` (skipped while `NIGHTSHIFT_OPERATOR_BOT` is `on`), `deploy_web.yml` |
| Tests | `tests/test_operator_bot_*.py`, `tests/test_tg_text.py`, `tests/test_run_telegram_control.py`, `tests/test_operator_bot_service.py`, `tests/test_deploy_gha.py` |
