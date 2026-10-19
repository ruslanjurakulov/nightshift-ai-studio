# Owner e-mail alerts

E-mails to the **site owner's own address** (platform owner and admins, never a customer) for payments, new
accounts, system problems and a daily digest. **Off by default.** No migration. Code:
`modules/operator_bot/owner_mail.py` (sink, recipients, rendering), `owner_digest.py` (the daily digest),
`store.py` (the `operator.mail` ledger), wired in `alerts.py` and `tools/run_operator_alerts.py`.

## What the owner gets

| E-mail | When | Alert kind | Notes |
| :-- | :-- | :-- | :-- |
| Payment received | a provider event `transaction.completed` that was credited | `payment` (e-mail only) | amount, currency, short id, age |
| Payment problem | a payment `rejected` (critical), `failed`, or a refund / chargeback applied | `payment` | the bot's existing alert, same wording |
| New accounts | an organization created (every sign-up creates one; that is what is counted) | `signup` (e-mail only) | a count of the mail's lines in the subject, a short list of short ids and ages. **No name, no address, no slug.** At most 3 a mail an hour, the rest the next hour. |
| Failed / stuck jobs | a render job failed, a job stuck, an error burst | `run`, `stuck` | ids and channel ids, as the bot |
| Worker problem | a worker heartbeat gone stale, a worker `failed` | `worker` | critical |
| Deploy or CI failed | the latest `deploy` / `tests` / `frontend` run on `main` failed | `deploy` | needs the bot's `GITHUB_*` settings, as the bot |
| Video pipeline | no video for a scheduled operator channel by its publish hour + grace (the dead-man switch), a failed daily workflow run, a blocked video, a failed upload (a "recovered" note goes to Telegram only) | `pipeline` | channel ids, UTC times, run numbers, workflow job and step names; never a title or a log (docs/operator-bot.md, "Reliability alerts") |
| Readiness | the scheduled readiness check is failing a check or has stopped reporting, a provider balance snapshot stopped refreshing | `health` | the doctor's check names only; never a value |
| Poster problem | a brand-channel post `failed` or ended `dead` | `marketing` | status and closed codes only, **never a post's text**; "drafts waiting" and "post sent" are not e-mailed |
| Daily digest | once a day from `OPERATOR_DIGEST_HOUR`, owner's time zone | | yesterday's payments total, new accounts, videos made / published / held / failed, provider cost estimate, what needs attention |

Opt-in kinds (off unless named in `OWNER_EMAIL_KINDS`): `balance`, `audit`, `approval`.

The digest follows CLAUDE.md #5: a total built from payments or cost rows without an amount reads **"at least"**,
an amount that is not known reads "amount unknown", a source that could not answer is listed under "Could not
check", and "Nothing needs attention." is written only when every source answered.

Subjects are short and carry no id, amount or name: `Payment received`, `CRITICAL · Worker problem`,
`New accounts: 3`, `Daily digest 2026-10-13`. Each mail is plain text plus a simple HTML card, in the owner's
language (en / ru / uz).

## The decision: a second sink on the operator alert engine, no new table

**Chosen design.** `AlertEngine.tick()` already reads every source with the service key, decides what is news and
applies dedupe, mute, quiet hours and an hourly limit. It gets one more way out beside Telegram: `OwnerMail`
(`owner_mail.py`), which receives the SAME detected events and sends them as e-mail through the SAME Resend
transport the customer e-mail worker uses (`modules/email_notify.py`: `ResendTransport`, `Message`, `TransportError`,
`clean_line`, the HTML shell). Two events the bot does not announce (a payment received and a new account) are added
for the e-mail only, so Telegram is unchanged.

**Why this and not the alternatives.**

| Option | Verdict |
| :-- | :-- |
| **Second sink in the alert engine** (chosen) | One detection, one set of rules, no new table, no migration, three languages from the bot's copy tables. The owner's `/language`, `/alerts` mute, quiet hours, digest hour and hourly figure all keep their meaning. |
| Enqueue into `notification_outbox` / the customer `email-worker` | The outbox and `email_claim_*` functions are per-customer (a person's preferences, a ledger keyed by user, an unsubscribe token). An owner message would need a new `kind`, a new claim function and a render path: more than one migration, and customer and operator mail would share a queue. Rejected. |
| A new `email-worker` mode reading the alert sources | That container holds the mail key and nothing about the alert settings (time zone, quiet hours, digest hour, GitHub token, language): it would need about ten more names and a second copy of the detection. Rejected. |
| A migration with a service-only `owner_email_recipients()` function | Would make the recipient query one auditable SQL function. Not needed: see "Who gets it". It can be added later without touching anything else here. |

**Cost of the choice, and how it is limited.** The operator-bot container can hold a mail key (previously only the
e-mail worker did), because the bot's pass is where the events are. That key is **its own secret,
`OPERATOR_RESEND_API_KEY`**, not the customer e-mail worker's, and it reaches the container (and the fallback workflow)
**only while `NIGHTSHIFT_OWNER_EMAIL` is exactly `on`**: the workflow maps it with
`vars.NIGHTSHIFT_OWNER_EMAIL == 'on' && secrets.OPERATOR_RESEND_API_KEY || ''`, and `deploy/build-service-env.py` writes
it empty unless the switch is `on` even if a mapping were wrong. How much damage a stolen key can do depends on which
Resend key it is: **it can only send from your one domain if you create it as a Resend "Sending access" key restricted
to that domain** (full-access keys can do much more). Creating that restricted key is an owner step below; the code
cannot check it. `tests/test_deploy_gha.py` pins the gating, the dedicated secret name and that this is the ONLY name of
its "must never see" list the operator env may carry.

**It rides the alert pass.** It runs inside `AlertEngine.tick()` (the `operator-bot` service every 5 minutes, or the
`operator_alerts.yml` fallback), after the Telegram part, so a slow mail provider never delays a ping. No Telegram
configuration means no pass and no e-mail.

## Who gets it

Only people on the platform roster as `owner` or `admin` **and** whose address Supabase Auth has **confirmed**:

1. `app_members` is read with the service key for `user_id` and `role` only (the roster's own `email` column is never
   selected: it is what somebody typed, or an invitation, not a verified address).
2. Owners come first, then the oldest admins (`order=role.desc,created_at.asc`, and sorted again here so the choice is
   the same on every pass). For each such `user_id`, Supabase Auth's admin endpoint (`GET /auth/v1/admin/users/{id}`, service key) gives the
   address; it is used only when `email_confirmed_at` is set, the id in the answer is the one asked for, the account
   is not banned and the address is well-formed. At most three addresses, and the whole lookup gets 20 seconds (what was
   confirmed by then is used, and the answer is asked again on the next pass rather than cached).
3. Nobody qualifies, or either read fails: **nothing is sent and nothing is recorded** (fail closed). An empty roster
   (the bootstrap state of 0007, where "everybody is owner") qualifies nobody.

No argument, no environment value and no browser input ever names a recipient. Customers are never recipients.

## What can appear in an e-mail

Only what the Telegram alerts already show: ids, counts, statuses, amounts with currency, fixed words. Each line is
stripped of markup, run through `tg_text.sanitize_outgoing` (e-mail addresses, bearer tokens, key shapes), clipped,
and HTML-escaped again for the HTML part. The sources never select a customer's name, e-mail, organization name or
free text (`OperatorSources` docstring); a test proves that no customer address or name reaches a subject, text or
HTML, and that the roster is queried for `user_id,role` only. No secret, key or address is logged: logs carry counts
and machine codes (`http_503`).

## The restraint

Same rules as the bot, applied to the e-mail with a **ledger of its own** (`operator.mail` rows in `alert_events`,
`channel_id` NULL, like the bot's other state; a row that carries a channel is ignored):

* **First pass.** Marks everything that exists as seen, sends one "Owner e-mail alerts are on", announces no history.
  The marker is written only when there is a recipient.
* **Dedupe.** Same keys and cooldowns as Telegram. A payment or an account is mailed once.
* **Mute and quiet hours.** `/alerts` mute (24 h) and `OPERATOR_QUIET_HOURS` apply; critical alerts pass quiet hours
  and a mute of `all`. Held alerts are not dropped: they go out after the window if they still apply. A mute does not
  stop critical mails or the daily digest.
* **Hourly budgets, three separate ones** (attempts count, sent or not): problems `OPERATOR_ALERT_MAX_PER_HOUR`,
  critical 10, and news (a payment received, a new account) 3, so six sign-ups can never hold back a failed job and a
  flood of failures cannot hold back the news. Merged into one mail per kind per pass, at most 10 lines each ("+N more").
* **Bounded retries, and never given up for good.** After a failed delivery the whole sink backs off (5, 10, 20, 40,
  then 60 minutes, doubling per failure in a row) and the rest of the pass waits. Per alert: at most 3 failed attempts
  per window (the alert's cooldown, 3 hours for a one-off alert), 15 minutes apart; when the window has passed an
  alert that is still true is tried again, so an outage delays a mail and does not drop it. A refused key (HTTP 401 /
  403) is a configuration problem, not a verdict on any alert: it marks no alert, only backs the sink off, and the next
  pass after the owner fixes the key delivers. The "Owner e-mail alerts are on" mail is retried the same way until it
  has gone out once. When several owners are mailed and one fails, the others are not mailed again ("sent if any").
* **Visible failure.** After two failures in a row Telegram gets one info note per local date: "Owner e-mail is
  failing: http_503" (a closed code only; the usual mute and quiet hours apply, kind `email`). `/alerts` shows
  "Owner e-mail: working, last sent ..." or "FAILING (code), N in a row".
* **Memory.** A ledger row the store refuses is remembered in memory (bounded) so the next pass does not re-send; a
  ledger that cannot be read sends nothing. The e-mail ledger's own marker is read only while the sink is on, and if
  that one read fails Telegram carries on as usual and the e-mail waits.
* **Never raises.** `OwnerMail.run()` catches everything: the bot's Telegram part and its loop are unaffected.
* **Digest.** From `OPERATOR_DIGEST_HOUR`, once per local date, never inside quiet hours (it waits for the window to
  end), at most 3 attempts.

## Settings (all optional; off unless the first one is exactly `on`)

| Name | Where | Meaning |
| :-- | :-- | :-- |
| `NIGHTSHIFT_OWNER_EMAIL` | variable | the master switch: **exactly `on`**. Anything else, including `ON`, `true`, ` on`, unset: off. |
| `OPERATOR_RESEND_API_KEY` | secret | a **restricted Resend "Sending access" key** for your one domain, created for this and used by nothing else; the deploy passes it to the container as `RESEND_API_KEY` and only while the switch is `on` |
| `NIGHTSHIFT_EMAIL_FROM` | variable | the sender, e.g. `Nightshift <alerts@your-domain>`; the same variable as the customer e-mail worker (a non-secret) |
| `OWNER_EMAIL_KINDS` | variable | which kinds, comma-separated (see above). Empty: payment, signup, run, stuck, worker, deploy, marketing, pipeline, health. This is the permanent per-kind opt-out; it needs a redeploy. |
| `OPERATOR_*` | variables | existing: `OPERATOR_APP_URL` (links), `OPERATOR_TZ`, `OPERATOR_QUIET_HOURS`, `OPERATOR_DIGEST_HOUR`, `OPERATOR_ALERT_MAX_PER_HOUR`, `OPERATOR_LANGUAGE` |

Deploy wiring follows the other workers: `deploy/.env.operator.example` (the four names, optional),
`deploy/build-service-env.py` (`OPTIONAL["operator"]`), `.github/workflows/deploy_web.yml` (step "Build the
operator-bot env": the switch, kinds and sender from `vars.`, the key from `secrets.OPERATOR_RESEND_API_KEY` behind the switch) and `operator_alerts.yml` (the
fallback). `tests/test_deploy_gha.py` pins the mapping; `tests/test_owner_email.py` pins the behaviour.

**Language.** The owner's language is the one chosen with `/language` in the operator bot (the `operator.language`
row), else `OPERATOR_LANGUAGE`, else English. (Migration 0105's `notify_language_ok` covers customers' channels and
e-mail preferences; the owner's choice is the bot's, so one `/language` changes Telegram and e-mail together.)

**Footer.** Every mail says why it was sent and how to pause it: send `/alerts` to the bot and tap **Mute all 24h**
(new accounts have no mute of their own; payments, jobs and the rest also have per-kind buttons), which does not stop
critical mails or the daily digest, or switch it off for good with `NIGHTSHIFT_OWNER_EMAIL`; it links to the Alerts page
of the app (from `OPERATOR_APP_URL`; no link is guessed without it). There is no per-mail unsubscribe link: a
one-click link would need a signed token and a write endpoint, which is a migration and a route for one recipient.

## Turn it on (from a phone)

1. GitHub app or github.com, the repository, **Settings, Secrets and variables, Actions**.
2. Create a key just for this: in the **Resend dashboard, API Keys, Create API Key**, permission **Sending access**,
   **Domain: your sending domain** (not "All domains"), name it e.g. `nightshift-owner-alerts`. Copy it once. In GitHub
   add it as the repository **secret** `OPERATOR_RESEND_API_KEY`. (Do not reuse the customer e-mail key.) Check the
   variable `NIGHTSHIFT_EMAIL_FROM` is set, e.g. `Nightshift <alerts@your-domain>` (the domain must be verified in Resend;
   `docs/NOTIFY_TELEGRAM_SETUP.md`).
3. Check the operator bot is on (variable `NIGHTSHIFT_OPERATOR_BOT` = `on`) and set, if you have not,
   `OPERATOR_APP_URL`, `OPERATOR_TZ` (e.g. `Asia/Tashkent`), `OPERATOR_DIGEST_HOUR` (e.g. `8`) and
   `OPERATOR_QUIET_HOURS` (e.g. `23-7`).
4. Make sure you are listed as owner or admin in the app (Team) and that the e-mail you sign in with is confirmed.
   That is the address that will be used; nothing is typed anywhere else.
5. Add the variable `NIGHTSHIFT_OWNER_EMAIL` (a **variable**, not a secret) with the value `on` (small letters, nothing else).
   Optionally `OWNER_EMAIL_KINDS`.
6. Run the **Deploy** workflow (or merge any change to `main`). Within about 10 minutes an e-mail "Owner e-mail alerts
   are on" arrives; the first digest comes at your digest hour.
7. To stop: delete the variable or set it to `off`, and deploy again (the key is then no longer passed to the server).
   To pause for a day: send `/alerts` to the bot and tap Mute all 24h. If a note says "Owner e-mail is failing", check
   the key and the sender domain; it retries by itself once they are right.

Choose your language once with `/language` in the Telegram bot.

## Not verified

* The Supabase Auth admin lookup (`/auth/v1/admin/users/{id}`) and Resend delivery have not been run against the live
  services (no database or mail access from the build). The lookup is covered with a fake; if the live answer differs
  (for example a different field name for the confirmation time) the result is **no recipients and no mail**, never a
  wrong recipient. The first live check is the "on" mail.
* The ru / uz copy has not been read by a native speaker.
