# Migrations: the process rule

**Never edit a migration that has been merged. Add a new forward migration.**

`supabase/migrations/NNNN_name.sql` is applied once per database, by hand or by
the Supabase GitHub integration, and then recorded as applied. Editing the file
afterwards changes nothing in a database that already ran it, but it does change
what a fresh database gets, so the two drift apart. The next migration, whose
guard names something only the edited text creates, then fails on production.

That is exactly what happened with 0103: commit `001a2971` edited
`0064_notifications.sql` after 0064 was live (adding `notification_emit_org_role`,
the admin-only `storyboard_ready` audience, and the per-organization
`credits_low` key). 0103's guard required `notification_emit_org_role`, so it
failed on the live database with `0103 needs the notifications ...`.
0103 now carries those three deltas itself (section 0, `create or replace`).

## What to do instead

- Need to change something an earlier migration made? Write `NNNN+1`, with
  `create or replace`, `add column if not exists`, drop-then-create for
  constraints and triggers, so it is safe on both an old and a fresh database.
- A guard (`to_regprocedure(...) is null` / `to_regclass(...) is null`) may name
  only what an earlier migration created in its **first merged form**, or what
  the same file creates before the guard.
- A typo or comment fix in a merged migration is still an edit: do not.

## How it is enforced

`tests/test_migration_prerequisites.py` (part of `python3 -m unittest discover tests`)
checks every such guard in migrations numbered 0100 and up: the object must be
created in the same file before the guard, or by an earlier migration (or
`schema.sql` / `tests/security/bootstrap.sql`) and, using git history, already
in that migration's first merged version. Guards written `is not null` are
optional features and are not checked. The CI test job checks out full history
for this.

The `rls` job (`.github/workflows/security.yml`) additionally applies every
migration to a fresh PostgreSQL 16 in order. It cannot see drift by itself,
because a fresh database always has the edited text; to test an upgrade path,
apply the old version of the earlier migration
(`git show <sha>:supabase/migrations/NNNN_name.sql`) and then the new one.

## When a migration changes what a Python writer sends

A migration is applied to the live database the moment it merges, and the nightly
jobs run from `main` straight after. So a writer that starts using a new column
must still be safe against a database that has not applied it yet (a delayed
apply, a stale PostgREST schema cache). Pick the option that cannot corrupt data:

- A write that would **duplicate** rows if it fell back to the old shape (an
  append-only table) is skipped for that run, logged with the migration's name,
  and retried by the next run. 0106 does this for the `video_costs` mirror: the
  new `row_key` column is its idempotency key, so without it nothing is sent.
- A write that is harmless in the old shape may fall back.

Anything that has to clean up existing rows is an **owner-applied script** under
`docs/sql/`, not a migration: it previews first, ends in `ROLLBACK`, and the
owner changes that to `COMMIT`. `docs/sql/dedupe-video-costs.sql` (for 0106) is
the example; a lab test runs it against the same fixtures the Python code is
tested with, so the two implementations of a key cannot drift apart.

Unique indexes that PostgREST upserts into (`on_conflict=col`) must be **plain**,
not partial: PostgREST cannot send the index predicate, and Postgres then answers
42P10. A plain unique index still lets NULLs coexist.

## Migrations that ship dormant (0107)

Some migrations are written to change nothing until a later change turns them on. 0107
(`0107_owner_safety.sql`: the database half of the admin second factor, audited owner actions, the
security trail) is the model: new tables and functions only, every switch off by default, no existing
policy, grant, trigger or function touched except the audit action list, which only gained names.
`tests/test_owner_safety_migration.py` fails if that ever stops being true.

- **Is it off?** `select admin_aal2_required from public.owner_security_settings;` must read `false`
  until the owner enrols two authenticators and switches it on (`docs/security/ADMIN_MFA.md`).
- **Is it working?** The verify block at the bottom of the file, and `select kind, at from
  public.security_events order by id desc limit 20;` (the three logging triggers fill it from any
  write to `app_members`, `credit_prices` or the settings row).
- **Wired?** Not until the server variable `NIGHTSHIFT_OWNER_RPC` is `on` (default off): then the Credits, Team, Billing and
  Security pages use the functions (docs/security/ADMIN_MFA.md, "Wiring the screens"). That variable is separate from the
  database gate; neither implies the other.
- **Undo.** The flag is the undo for behaviour. To remove the objects: `docs/sql/rollback_0107_owner_safety.sql`
  (owner-applied; the lab applies it to a scratch database and then re-applies 0107).
- **Replay.** The seed is `on conflict do nothing`, so re-running the file keeps whatever the owner set.
  Re-running 0093 or 0087 afterwards would put the old audit list back and the owner functions would
  start to fail loudly at their audit write (never silently): re-apply 0107 after it.

## Migrations that ship dormant (0108)

0108 (`0108_marketing_posts.sql`: the database half of the brand-channel poster, `docs/MARKETING_POSTS.md`) follows the
0107 pattern: new tables and functions only, every switch off, no existing policy, grant, trigger or function touched
except the audit action list, which only gained eight names (0107's list is copied verbatim; a test compares the two).
`tests/test_marketing_posts_migration.py` fails if that ever stops being true, and fails if anything in the application
starts to call the new objects other than the poster worker and, since the owner page, `/{channel}/marketing` with
`POST /api/marketing` (behind `NIGHTSHIFT_MARKETING_POSTS`, off by default; `docs/MARKETING_POSTS.md`).

- **Is it off?** `select enabled from public.marketing_settings;` must read `false`. While it is false,
  `claim_marketing_post()` hands out nothing, however much is approved.
- **Is it working?** The verify block at the bottom of the file.
- **Undo.** The switch is the undo for behaviour (`update public.marketing_settings set enabled = false where id;`). To remove the
  objects, and the record of every post: `docs/sql/rollback_0108_marketing_posts.sql` (owner-applied; the lab applies it
  to a scratch database and then re-applies 0108).
- **Replay.** The seed is `on conflict do nothing`, so re-running the file keeps whatever the owner set. Re-running 0107
  afterwards would put 0107's audit list back and the owner functions would fail loudly at their audit write (never
  silently): re-apply 0108 after it.

## A read-only function for the operator bot (0109)

0109 (`0109_operator_marketing_summary.sql`) is one `SECURITY DEFINER` function, `operator_marketing_summary()`, and nothing
else: no table, policy, trigger or other function is created or changed (`audit_action_allowed` included). 0108 took every table
privilege on the poster's tables away from `service_role`, so the operator bot (which reads with the service key) cannot select
from them; the function returns counts by status, the week's use of the cap, the switch, the last sent post and the last failure
(kind, closed code, time), and never a post's words, link, media or chat. `EXECUTE` is granted to `service_role` only.
`tests/test_operator_marketing_summary_migration.py` pins that from the file; `tests/security/test_sec_marketing_summary.py`
attacks it in the lab.

- **Is it working?** The verify block at the bottom of the file (every column true), or as the SQL editor:
  `select public.operator_marketing_summary();`.
- **Wired?** The bot's `/marketing` and its `marketing` alerts call it (`docs/operator-bot.md`, "Marketing"). Before it is applied
  the bot says "not available yet" and sends no marketing alert; nothing else changes, so the order of merge and apply does not matter.
- **Undo.** `docs/sql/rollback_0109_operator_marketing_summary.sql` (owner-applied; the lab applies it to a scratch database and
  then re-applies 0109). It drops the function and nothing else.
- **Replay.** `create or replace` plus a revoke and a grant: a replay leaves the same function and the same privileges.

## Promo and custom posts (0110)

0110 (`0110_marketing_promo_custom.sql`: `promo` and `custom` kinds for the brand-channel poster, `docs/MARKETING_POSTS.md`) ships
dormant: it adds `owner_marketing_create` and `marketing_draft_upsert_v2`, widens two CHECKs on `marketing_posts` (kind,
source_ref), adds one (key_shape) and adds `marketing.create` to the audit list. No 0108 function, trigger or grant is redefined.
`tests/test_marketing_promo_custom_migration.py` pins that from the file.

- **Is it off?** Yes, by absence: no code calls `owner_marketing_create` or `marketing_draft_upsert_v2` yet (the static test fails if
  any file mentions them), so no `promo` or `custom` row can exist. **Depends on PR #526 (the tolerant approval page and bot)
  being DEPLOYED before any slice that calls them**: the page rejects an unknown kind and reads the whole list as "could not read".
- **Undo.** `docs/sql/rollback_0110_marketing_promo_custom.sql` (owner-applied; the lab applies it, then re-applies 0110). It drops
  the two functions and restores 0108's audit list. If `promo` or `custom` rows exist it leaves the wide CHECKs in place (a post is
  never deleted), which is harmless.
- **Replay.** `create or replace`, drop-then-create for the constraints, revoke then grant: a replay leaves the same objects.
  Re-running 0108 after 0110 puts 0108's audit list back and drops `marketing.create`, so `owner_marketing_create` then fails
  loudly at its audit write (the insert rolls back, nothing is half-done): re-apply 0110 after it.
- **Promo keys are permanent.** `promo:<slug>:telegram` is never freed: a rejected or expired promo cannot be redrafted, and
  `marketing_draft_upsert_v2` returns the old row (`created: false`, `updated: false`). The worker slice must log
  "already exists (status X)" rather than treat it as an error.

## Video safety: provider choice, coded job errors, the hold sweep (0111)

0111 (`0111_video_safety.sql`: the database half of three follow-ups of the paid-API video pipeline audit) is NOT dormant: it takes
effect the moment it is applied. It creates no table, column, policy, trigger or audit action. It redefines three functions from the
latest migration that defines each (`render_jobs_payment_guard` from 0076, `api_get_job` from 0042, `oauth_get_job` from 0093; every
other line of every body is the old text, which `tests/test_video_safety_migration.py` compares), adds one pure helper,
`render_job_public_error(status, error)`, and schedules one pg_cron job.

- **D8, a customer's job never names a provider.** For an organization that pays (not `credits_exempt`), `render_jobs_payment_guard`
  now refuses an insert whose params carry a non-blank `video_provider` or `image_provider` (SQLSTATE 42501, "render job refused:
  video_provider and image_provider cannot be set for this organization"). The one before-insert trigger covers the browser, the
  service key, `api_create_video` and `oauth_create_video`; the routes already refuse the fields earlier (#535). The operator's own
  organization is unaffected. Blank and null pass the trigger as the REST route tolerates them (the params CHECK still refuses a blank
  as a provider id, as before). Insert only: a queued job's params are frozen by `render_jobs_terms_frozen`, and a job queued with a
  provider before 0111 is still claimed and finished. A direct database caller of `api_create_video` / `oauth_create_video` that names
  a provider is answered 500 `internal_error` with nothing created or charged (their exception block rolls the hold back).
- **D12, the API and MCP job answer.** `api_get_job` and `oauth_get_job` return `error` as one fixed sentence and a new `error_code`
  (`credits | voice | provider_quota | media | render | timeout | unknown`) read from the worker's `[code:xxx] ` prefix, for a FAILED job
  only; anything else reads `null` / `null`. The sentences are the Create page's (`lib/i18n/en.ts` `create.jobError`; a test compares
  them). `withPublicJobError` (`lib/api/operations.ts`) already mapped the same way and now passes an answer that already has
  `error_code` through untouched. **Deploy order:** merge and apply together. An app older than this commit, run against an applied
  0111, answers `unknown` for every failure (never the log); a database without 0111 under the new app is mapped in TypeScript as before.
- **D15, the sweep.** When pg_cron is installed (`cron.schedule` and `cron.job` exist), `expire_credit_reservations()` runs every 10
  minutes as the job `nightshift-expire-credit-reservations` (unscheduled first, so a replay leaves one). Without pg_cron the file still
  applies and says so in a NOTICE; the worker's own sweep keeps working. The function is not changed. It is safe beside a settlement:
  capture, release and start take the account lock first and the hold row second, and the sweep re-reads the hold under both and only
  acts on `open` (lab test: a capture mid-flight makes the sweep wait, then it finds the hold captured and releases nothing). The one
  consequence worth knowing: a hold that was never started is released 3 hours after it was reserved even if its job is still queued
  because the worker is down, so that job later fails "reservation not open" and the customer is charged nothing.
- **pg_cron is NOT installed on the live project, so the D15 schedule is skipped there.** Applying 0111 on the live project therefore
  prints the NOTICE and creates no cron job: the only sweep is the worker's own (`tools/queue_worker.py`, while it runs). To enable the
  10-minute sweep, install the extension first (Supabase > Database > Extensions > pg_cron), then run once in the SQL editor:
  `select cron.schedule('nightshift-expire-credit-reservations','*/10 * * * *','select public.expire_credit_reservations()');`
  (re-running 0111 after the extension is on does the same, with an unschedule first). Check it with the `cron.job` query under
  "Is it working?". This note is about the live project's state, not the file: the migration is unchanged.
- **Is it off?** No, there is no switch: the refusal and the new job answer are live on apply. Both are no-ops for every request the app
  sends today (no screen or route sends a provider for a customer; the job answer is what the TypeScript layer produced anyway).
- **Is it working?** The verify block at the bottom of the file (every column true), and, if pg_cron is on,
  `select jobname, schedule from cron.job where jobname = 'nightshift-expire-credit-reservations';`.
- **Undo.** `docs/sql/rollback_0111_video_safety.sql` (owner-applied; the lab applies it to a database built from 0001-0110 and compares the
  three functions with it byte for byte, then re-applies 0111). It puts the three functions and their grants back, drops the helper and
  unschedules the job. To stop only the sweep: `select cron.unschedule('nightshift-expire-credit-reservations');`.
  `tests/security/test_sec_video_safety.py` is the lab test.
- **Replay.** `create or replace` plus revoke then grant for the functions, unschedule-then-schedule for the job: a replay leaves the same
  definitions, the same privileges and one cron job. Re-running 0076, 0042 or 0093 afterwards would put the old body back (the refusal
  gone, the raw error returned): re-apply 0111 after it.

## Approve is a decision bound to the exact cut (0112)

0112 (`0112_approve_video_publish.sql`: Phase 1a of the approve-and-publish design) is NOT dormant: it takes effect the moment it is
applied, but it publishes nothing and calls nothing outside the database. It adds nullable columns to `videos` (`cut_sha256`,
`gate_verdict`, `approved_cut_sha256`, `decided_by`, `decided_by_email`, `decided_at`, `approval_expires_at`) and one to `review_intents`
(`approved_cut_sha256`), five functions, and changes one policy, two function bodies and the audit list.

- **`approve_video_publish(video_id, cut_sha256, ack)`** (signed-in only, not anon, not the service key). The organization comes from the
  video row. Needs an administrator of the channel's organization; a platform owner/admin acting on a CUSTOMER channel must also be a real,
  bound member of that organization (`video_real_member`, 0112: `inbox_real_member`'s rule under its own name, because a database built from 0081 as first merged may lack that function), in the operator's own organization any platform owner/admin may. 20 calls
  per person per 10 minutes. The reviewer's checksum must equal the stored cut (`cut_changed` otherwise), the video must be uploaded, have a
  preview and a stored, passing gate verdict (`gate_blocked` / `gate_unknown` / `not_uploaded` / `already_public` / `no_preview` / `cut_unknown` / `rejected`),
  and the acknowledgement `{"rights_and_labels": true}` must be given. It then sets `review_state = 'approved'` with who/when/until (24 hours),
  writes one consumed `review_intents` row and one `video.approve` audit row, and closes the stuck `approve` intents of the dead button as
  `superseded_by_approval`. The same call again while the approval is valid returns `{ok, already: true}` and writes nothing.
- **`video_approve_access(video_id)`** (signed-in) answers `ok | not_admin | not_member | not_found` for the caller and the video; the RPC maps it and the panel asks it to decide whether to offer the key.
- **`video_publish_refusal(video_id, cut_sha256)`** (service role only) is the rule a Phase 1b worker applies before it acts on an approval
  (eligibility, which includes `already_public`, then `not_approved`, `cut_changed`, `approval_expired`). Nothing calls it yet. `video_approve_refusal` is its
  internal eligibility half (no API role).
- **A browser can no longer insert an `approve` intent** (`review_intents_insert` is 0033's policy plus `action <> 'approve'` and `approved_cut_sha256 is null`, so a browser cannot write the
  approval's hash on any row; the other actions are as they were).
- **`finish_scene_regeneration`** is 0085's body with one statement extended: the approval's columns are cleared with its state.
  **`audit_action_allowed`** is 0110's list plus `video.approve`.
- **What it does not change:** `publish_request_refusal` (0029). The cross-post rail still reads `review_state = 'approved'`; that is now
  reachable on a channel with auto publish off. An approval stays `approved` after its 24 hours (the panel shows it as expired and
  `video_publish_refusal` says `approval_expired`); it does not close the cross-post rail.
  **Known, accepted limitation:** a cross-post of a video whose approval has expired is still accepted, because the rail reads only
  `review_state`. Cross-posts are always private uploads and each needs a human click, so the owner accepted this rather than change
  `publish_request_refusal`.
- **Deploy order:** apply 0112 and deploy the web app and the pipeline of the same commit together. The pipeline writes the new columns only
  when they exist (an older database is written without them, and logs nothing new); an app older than this commit never calls the
  function, and its direct insert of an `approve` intent is refused with 42501 once the policy is applied. A video uploaded before 0112 has
  no recorded cut or verdict, so it reads `cut_unknown` / `gate_unknown` and cannot be approved here (make it public in YouTube Studio).
- **Is it working?** The verify block at the bottom of the file (every column true).
- **Undo.** `docs/sql/rollback_0112_approve_video_publish.sql` (owner-applied; the lab applies it to a database built from 0001-0111,
  compares the two replaced functions and the policy byte for byte, then re-applies 0112). It drops the three functions, puts the policy,
  `finish_scene_regeneration` and `audit_action_allowed` back, and KEEPS the columns (a record of who approved what).
  `tests/security/test_sec_approve_video.py` is the lab test, `tests/test_approve_video_migration.py` pins the file.
- **Replay.** `add column if not exists`, guarded constraint adds, `create or replace` plus revoke then grant, `drop policy` then `create
  policy`: a replay leaves the same objects. Re-running 0085 or 0110 afterwards would put the old function / audit list back (the approval
  columns would no longer be cleared by a repair, and `approve_video_publish` would fail loudly at its audit write): re-apply 0112 after it.

## The AI-disclosure settings that lower the label are a platform administrator's (0114)

- **What it does.** `agent_config.ai_disclosure = never` and `ai_disclosure_voice = own_clone` (the two values that reduce what
  is declared to YouTube, Instagram and TikTok) can be set only by `is_platform_admin()`. `channels_config_guard()` (0086's body,
  every earlier check kept) refuses an INSERT or UPDATE of `channels` that SETS either key to a value the Python reader would
  read as `never` / `own_clone` (case and whitespace variants included) unless the caller is a platform administrator; a write that
  leaves the stored value, or raises the label, passes. `create_channel` (a definer, so the trigger cannot see the browser) makes
  the same check on `p_agent_config`. The service role, the SQL editor and the other definer functions pass, as for 0086's controls.
  Two new pure helpers (`ai_disclosure_norm`, `channel_label_lowering`) are the one definition of "lowering", executable by the browser roles
  because the trigger runs as the caller.
- **What each lock buys.** Only `never` lowers the label itself; `own_clone` and `generic` give the same label in `decide()` (only `real_person` adds a reason), so locking `own_clone` protects the audit signal (`overrides_of`: "a person chose this"), not the label.
- **Rewrites no row; no backfill.** Live check before applying: no channel has either key.
- **Deploy order.** Independent of the web app: apply 0114 any time after 0086. 0113 was first reserved for PR #543 and is skipped (that PR took 0116, see below); 0114 touches none of its functions and may be applied before or after it. Until the Command Center of the same commit is deployed,
  the database refuses the two words for a non-platform-administrator without the localized sentence (nothing offered them before).
- **Is it working?** The verify block at the bottom of the file (every column true), and the detection query there (expected: no rows).
- **Undo.** `docs/sql/rollback_0114_ai_disclosure_admin_lock.sql` (owner-applied; the lab applies it to a database built from every earlier migration,
  compares the two functions and their grants byte for byte, then re-applies 0114). `tests/security/test_sec_ai_disclosure_lock.py` is the
  lab test, `tests/test_ai_disclosure_lock_migration.py` pins the file and the agreement with the reader.
- **Replay.** `create or replace` plus revoke then grant (the trigger is 0086's and is not dropped or re-created, so no lock is taken on `channels`): a replay leaves the same objects. Re-running 0086 afterwards
  would put the old guard back (the lock would be off): re-apply 0114 after it.

## The operator's own channels connect from the Command Center (0115)

0115 (`0115_operator_channel_token.sql`; 0113 was reserved by PR #543, which now carries 0116) adds ONE function,
`store_operator_channel_token(channel, refresh_token, meta)`, so the owner can press **Connect YouTube** on Chronos (and any other channel of
the operator's organization) and have the refresh token kept in Supabase Vault like a customer's, instead of pasting it into a GitHub secret.

- **Who.** A signed-in platform owner/admin (`is_platform_admin()`), for a channel whose `org_id` is the default organization. Everyone else
  (a customer's admin, an editor or viewer, an organization member who is not on the platform roster, anon, the service key) and every other
  channel get the same 42501 answer. `store_channel_token` is NOT changed and still refuses the operator's organization.
- **Dormant until used.** The function changes nothing by existing; without it the Command Center falls back to the GitHub-secret write.
- **Deploy order:** apply 0115, Deploy web (the button), then press it. Needs 0018 and 0022 (and the Vault extension). The runner side needs no
  deploy order: it prefers an active Vault connection and otherwise uses the old secret.
- **Is it working?** The verify block at the bottom of the file (every column true).
- **Undo.** `docs/sql/rollback_0115_operator_channel_token.sql` drops the function and KEEPS any stored connection (the runner keeps using it);
  `select public.revoke_channel_token('default');` removes it. `tests/security/test_sec_operator_channel_token.py` is the lab test.
- **Replay.** `create or replace` plus revoke then grant: a replay leaves the same objects.

## Publish when approved: the switch, the queue, the quota ledger (0116)

> **Numbering.** This file was drafted as `0113_visibility_requests.sql`. There is no 0113: 0114 and 0115 were applied to production first, and a migration
> numbered below the latest applied one is rejected or skipped by the Supabase CLI/integration, so it was renumbered 0116 (the text of the file is the
> draft's, with only the number changed).

0116 (`0116_visibility_requests.sql`: Phase 1b of the approve-and-publish design, `docs/APPROVE_PUBLISH_1B.md`) ships with the feature OFF: it
changes no video's privacy, calls nothing outside the database, and turns nothing on. Every channel's switch is `false` the moment it is
applied, and the worker that reads the queue (`tools/queue_worker.py`, `modules/visibility_publish.py`) is itself off unless
`NIGHTSHIFT_VISIBILITY_PUBLISH=on`. **It needs the owner's amendment of CLAUDE.md rules 2 and 3 before it is merged** (the proposal is
`docs/proposals/claude-md-rules-2-3-phase-1b.patch`, applied by the owner, not by this migration).

- **`channels.publish_on_approve boolean not null default false`**, written ONLY by `set_channel_publish_on_approve(channel_id, on)`: an
  administrator of the channel's organization who is a real member of it (a platform admin on a customer's channel is not), 30 calls per
  10 minutes, audited as `channel.publish_on_approve`. The browser roles' column grants (0086) are not widened, so a direct UPDATE is
  refused; a trigger refuses `anon`, `authenticated` and the SERVICE KEY outside that function (the owner of the database, the SQL editor,
  can: that is the documented undo). Turning it off refuses the channel's queued requests at once (`not_enabled`), except one whose write was
  marked (`submitting_at` set): that stays queued and the worker records what YouTube reports. A channel moved to another organization comes out off.
- **A channel that requires a second person cannot use it.** `channels.agent_config.require_two_person_publish` (0009; the rule the cross-post rail
  of 0029 and auto publish already apply) means one person's act must not make a video public. `set_channel_publish_on_approve` answers
  `{ok: false, error: 'two_person_required'}` instead of turning the switch ON for such a channel (OFF always works), and
  `visibility_request_refusal` (asked early and again inside `mark_visibility_submitting`, under the channel row lock) ends a request on one
  with the closed word `two_person_required`, whatever the order in which the switch and the requirement were set. Fail closed: this
  feature does not read `publish_approvals`; making the two cooperate would be its own design.
- **`video_visibility_requests`**: one row per approval act, unique `(video_id, approved_cut_sha256, decided_at)`, status
  `queued | applied | refused | failed | expired`, `reason` a closed word (`visibility_reason_words()`), never a provider's text. A CHECK says
  `applied` needs `after_privacy = 'public'`: the worker records that from a read-back of YouTube after its call, never from the call's own
  answer. A finished row is final (a trigger), except that a FAILED one may go back to `queued` (`retry_video_visibility`). Members read their
  organization's channels' rows without the worker's columns; no API role writes it, the service key included: every write is one of the functions.
- **`youtube_quota_ledger`**: the YouTube units this feature spent per Pacific-time day, project and organization (`youtube_quota_take`, with the
  day's ceiling and the organization's share that the worker passes; the all-zero `org_id` row is the whole day; `videos.update` = 50 units).
  A platform admin reads it. The claim serves organizations in turn; a request has a lifetime cap of six claims.
- **`approve_video_publish`** is 0112's body verbatim plus one block after its audit write: when the channel's switch is on, one request is queued
  for that approval act and one `video.publish_queued` audit row is written, and the answer gains `queued` and `request_id`. With the switch off
  the function does exactly what it did in 0112 (same writes, same answer): `tests/test_visibility_migration.py` pins the diff.
- **`audit_action_allowed`** is 0112's list plus `channel.publish_on_approve`, `video.publish_queued`, `video.visibility_applied`,
  `video.visibility_refused`, `video.visibility_failed`, `video.visibility_expired`, `video.visibility_retry`.
- **The worker's functions (service key only):** `claim_visibility_request` (a lease, backoff, three claims a round and six in all, organizations
  in turn, the expiry sweep that leaves a marked request alone), `visibility_request_refusal` (the switch is still on, the channel is still in the
  request's organization, this is still THE approval, not expired, the channel is connected),
  `mark_visibility_submitting` (the LAST check and the marker in one transaction under row locks: channel FOR SHARE, request FOR UPDATE, video
  FOR SHARE; answers `ok`, `not_holder` or a closed word; refuses the read-only claim a marked request gets after its claims are used up), `finish_visibility_request` (the only writer of a result; `videos.privacy` follows the
  read-back alone; it does not look at the switch), `youtube_quota_take` and `youtube_quota_refund` (units given back when the marker refused, clamped to the organization's own row and taken off both rows alike, so a repeat refund mints nothing).
  **The file supports fresh databases only**: a scratch database that took an earlier draft (different `youtube_quota_ledger` and
  `video_visibility_requests` columns) must be rebuilt, or have the rollback run and those two tables dropped, first. The video-level re-check is 0112's `video_publish_refusal`, called with the cut hash recorded at approval.
  `visibility_channel_connected` is `publish_channel_connected`'s rule under its own name (that function arrived in 0029 by a later edit).
- **Order of merge and deploy.** Apply 0116, then deploy the app (the panel and the Channels page read the new objects and degrade to the
  Phase 1a panel when they are missing). The worker needs the new code and `NIGHTSHIFT_VISIBILITY_PUBLISH=on`; nothing publishes before an
  administrator also switches a channel on. Do the live test on a disposable channel first (`docs/APPROVE_PUBLISH_1B.md`).
- **Is it off?** `select count(*) from public.channels where publish_on_approve;` must read `0`; the verify block at the bottom of the file.
- **Undo.** The switch is the undo for behaviour. To remove the objects: `docs/sql/rollback_0116_visibility_requests.sql` (owner-applied; run it
  BEFORE rollback 0112): it refuses every queued request that was never marked for a write (it stops with an error while a write may be in flight,
  and leaves an older marked one queued with a notice: check those videos in YouTube Studio), switches every channel off, drops the callable functions, puts 0112's
  `approve_video_publish` and `audit_action_allowed` back byte for byte, and KEEPS the two tables, the column and the three internal functions
  they need (a record of what was asked and what YouTube reported). The lab applies it to a database built from 0001-0112, compares the
  two restored functions, then re-applies 0116.
- **Replay.** `add column if not exists`, `create table if not exists`, `create or replace` plus revoke then grant, drop-then-create for the
  triggers and policies: a replay leaves the same objects and keeps every row. Re-running 0112 afterwards puts 0112's `approve_video_publish`
  and audit list back (approving would queue nothing, and the request functions would fail loudly at their audit write): re-apply 0116 after it.

## Custom voice: profiles, consent trail, the voice-samples bucket, ownership of a voice id (0117)

0117 (`0117_voice_profiles.sql`, `docs/CUSTOM_VOICE.md`) is **dormant**: it adds six tables, 29 functions (and replaces two), three guards and a private
bucket, and nothing in the application or a workflow calls any of it (`tests/test_voice_profiles_migration.py` fails if that
ever stops being true). The one caller is the voice worker (`modules/voice_worker.py`, `tools/voice_worker.py`): it is off unless the
repository variable `NIGHTSHIFT_VOICE_CLONING` is `on` (the owner sets it), nothing starts it, and it calls only the service role's
functions. The ElevenLabs account is on the free plan, which cannot clone, so nothing live can run: a clone job would end as
`provider_not_enabled`.

- **It is not dormant in one respect: the ownership rule.** Three entry points now refuse a provider voice id that is in `voice_profiles`
  unless it is its owner's (or attached to the channel by the owner): a `BEFORE INSERT` trigger on `creative_jobs`, one on `render_jobs`,
  and `channels_config_guard()` (0114's body plus one block, for every writer). With no profile in the table, which is the state on
  apply, every voice id behaves exactly as before.
- **Backfill.** One idempotent statement gives every existing user a random `owner_ref` (`user_voice_refs`). Row count after apply =
  `select count(*) from auth.users`.
- **Dormant at the API.** `request_voice_clone` is granted to nobody; the grant ships with the worker, the UI and the Actions pre-flight
  (`docs/CUSTOM_VOICE.md`, "Hard gate": the database rule does not cover the GitHub Actions backend).
- **Drift guard in the file.** A `DO` block raises if the live `channels_config_guard()` or `audit_action_allowed()` is not the 0114 / 0116
  body (md5 of the body with white space collapsed) or 0117's own.
- **Is it working?** The verify block at the bottom of the file (every column true) and the storage-policy queries there.
- **Replaced on their latest bodies:** `channels_config_guard()` (0114) and `audit_action_allowed()` (0116, plus eight `voice.*` names).
  Re-running 0114 or 0116 afterwards would put the old body back (the voice check on channels gone; the voice audit writes would fail
  loudly): re-apply 0117 after it. The 0086 trigger is not touched.
- **Undo.** `docs/sql/rollback_0117_voice_profiles.sql` (owner-applied; the lab applies it to a database built from every other migration,
  compares the two restored functions byte for byte, then re-applies 0117). It keeps the tables, their rows and the bucket.
- **Replay.** `create ... if not exists`, `create or replace`, drop-then-create for triggers and policies, revoke then grant: a replay
  keeps every row (`tests/security/test_sec_voice_profiles.py`).
- **Review.** Needs the independent security review before merge: it adds a closed bucket, restrictive policies on `storage.objects`,
  append-only tables and a rule on three hot paths.

## Series Factory S2: series_plans, series_episodes, the series_plan queue kind (0118)

0118 (`0118_series_tables.sql`, `docs/SERIES_FACTORY.md`, "Slice S2") adds two tables, eight callable and internal functions, three trigger
functions, the queue kind `series_plan` with its link column, and **replaces two live functions on their latest bodies**. Nothing in the
application, the worker or a workflow calls any of it (`tests/test_series_tables_migration.py` fails if that ever stops being true).

- **Replaced on their latest bodies, verbatim plus marked additions:** `render_job_params_valid()` (0029's; the optional `series` slug and the
  rule for the new kind) and `render_jobs_payment_guard()` (0111's; one block at the top: a job linked to a series plan must be exactly the job
  that plan queued). A `DO` block at the top raises if either live body is not the repo's (md5 with white space collapsed) or 0118's own.
  Re-running 0029 or 0111 afterwards would put the old body back: re-apply 0118 after it (the lab tests that replay 0111 do).
- **Dormant at the API.** `request_series_plan` is granted to nobody (the grant ships with the worker and the UI, S3): it queues a job the live
  worker has no handler for. `start_series_episode` and `quote_series_episode` are granted to signed-in users but have no episode to act on until
  the worker's `finish_series_plan` has run.
- **Python moves with the database.** `modules/run_request.ALLOWED_PARAMS` gains `series` in the same change (`tests/test_queue_worker.py` and
  `tests/test_series_dispatch.py` compare it with the migration). A worker that knows `series` before the migration is applied is harmless: the
  database refuses such a job until then.
- **Undo.** `docs/sql/rollback_0118_series_tables.sql` (owner-applied): refuses while a planning job or a run with a series is queued or running,
  deletes the finished planning rows, strips `series` from finished runs, puts both functions back byte for byte (and refuses to if a later
  change touched either), drops the callable functions, and KEEPS the two tables (the record of every plan and every paid start).
- **Is it working?** The verify block at the bottom of the file (every column true).
- **Review.** Needs the independent security review before merge: it replaces the payment guard every queued run passes through, and it adds a
  function that holds credits.
