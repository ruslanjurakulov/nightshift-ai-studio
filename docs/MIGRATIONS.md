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
`provider_not_enabled` (if the subscription says so explicitly) or be parked as `provider_plan_unknown` (if it says nothing).

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

## A spend limit an editor cannot raise or remove; the Channels page's settings in one atomic write (0119)

0119 (`0119_channel_settings_guard.sql`; 0118 belongs to the series-tables builder) is **live on apply**: it changes who may write a channel's
`agent_config.spend_ceiling_usd`, the one number that stops a channel spending. It adds two functions and replaces one; it alters no table,
trigger, policy or table grant and rewrites no row (`tests/test_channel_settings_guard_migration.py` pins that).

- **The rule.** `channels_config_guard()` (0117's body, character for character, plus ONE marked block) refuses a write by the browser roles
  that raises or removes a limit that is in force, unless the caller administers the channel's organization. Setting a first limit, keeping it
  and lowering it stay open to an editor. "In force" is the worker's reading on both sides (`channel_spend_ceiling(jsonb)` mirrors
  `modules/channels._as_optional_float`), so text, 0, a boolean, a list, an overflow or Unicode digits are "no limit" and cannot be used to
  dodge it. Refusal: SQLSTATE 42501, message `spend_ceiling_lock: ...`, hint `spend_ceiling_lock` (the page words it in en, ru and uz).
  The service role, the SQL editor and the definer functions are not held to it, as for every other check of the guard.
- **The function.** `patch_channel_agent_config(p_channel_id, p_patch)`, granted to signed-in users only, merges a patch of four keys
  (`spend_ceiling_usd`, `pinned_comment`, `watch_next`, `storyboard_review`; a JSON null removes a key) in a single `UPDATE`, so concurrent
  writers keep each other's keys. It is **security invoker on purpose**: it runs as the caller, so the guard above holds it to every rule
  (storyboard review is still an administrator's), and it cannot become a way round the lock. Any other key, a non-object or empty patch, or
  a value of the wrong kind is refused (SQLSTATE 22023, hint `invalid_patch`); a channel the caller cannot write reads the same whether it
  exists or not (42501, hint `channel_not_writable`).
- **Deploy order.** Apply 0119, then deploy the app: until the function exists the Channels page says the setting cannot be saved right now
  (it never falls back to writing the whole blob). Before the app is deployed the old page keeps working and is simply held to the new rule.
- **What changes for an editor.** The Voice, Cast and style-preset editors still write back the whole blob they loaded. If an administrator
  lowered, set or removed a limit after such a page was drawn, its save is now refused (it would have undone the administrator's change
  silently before); reload and save again.
- **Drift guard in the file.** A `DO` block raises if the live `channels_config_guard()` is neither 0117's body nor 0119's own (md5 of the
  body with white space collapsed). Re-running 0117 afterwards is refused for the same reason: re-apply 0119 on top of a fresh 0117 only.
- **Is it working?** The verify block at the bottom of the file (every column true), and the query there that lists the channels that carry a
  limit today with the number the worker enforces for each.
- **Undo.** `docs/sql/rollback_0119_channel_settings_guard.sql` (owner-applied; puts 0117's body back byte for byte, drops the two functions,
  refuses a body it has not seen; the lab applies it and re-applies 0119). After it an editor can raise or remove a limit again and the page
  cannot save its settings until the page change is reverted too.
- **Review.** Needs the independent security review before merge: it changes the guard of the channels table, which every channel write meets.

## Series Factory S2: series_plans, series_episodes, the series_plan queue kind (0120)

0120 (`0120_series_tables.sql`, `docs/SERIES_FACTORY.md`, "Slice S2") adds two tables, eight callable and internal functions, three trigger
functions, the queue kind `series_plan` with its link column, and **replaces two live functions on their latest bodies**. Nothing in the
application, the worker or a workflow calls any of it (`tests/test_series_tables_migration.py` fails if that ever stops being true).

- **Replaced on their latest bodies, verbatim plus marked additions:** `render_job_params_valid()` (0029's; the optional `series` slug and the
  rule for the new kind) and `render_jobs_payment_guard()` (0111's; one block at the top: a job linked to a series plan must be exactly the job
  that plan queued). A `DO` block at the top raises if either live body is not the repo's (md5 with white space collapsed) or 0120's own.
  Re-running 0029 or 0111 afterwards would put the old body back: re-apply 0120 after it (the lab tests that replay 0111 do).
- **Dormant at the API.** `request_series_plan` is granted to nobody (the grant ships with the worker and the UI, S3): it queues a job the live
  worker has no handler for. `start_series_episode` and `quote_series_episode` are granted to signed-in users but have no episode to act on until
  the worker's `finish_series_plan` has run.
- **Python moves with the database.** `modules/run_request.ALLOWED_PARAMS` gains `series` in the same change (`tests/test_queue_worker.py` and
  `tests/test_series_dispatch.py` compare it with the migration). A worker that knows `series` before the migration is applied is harmless: the
  database refuses such a job until then.
- **Undo.** `docs/sql/rollback_0120_series_tables.sql` (owner-applied): refuses while a planning job or a run with a series is queued or running,
  deletes the finished planning rows, strips `series` from finished runs, puts both functions back byte for byte (and refuses to if a later
  change touched either), drops the callable functions, and KEEPS the two tables (the record of every plan and every paid start).
- **Apply as ONE transaction** (SQL editor, `apply_migration`, or `psql --single-transaction -v ON_ERROR_STOP=1`). Numbered 0120 because 0119 merged first; 0118 is unused.
- **Before `request_series_plan` is granted:** the conditions in `docs/SERIES_FACTORY.md` (per-user cap, a worker handler, voice-guard interplay, language names).
- **Is it working?** The verify block at the bottom of the file (every column true).
- **Review.** Needs the independent security review before merge: it replaces the payment guard every queued run passes through, and it adds a
  function that holds credits.

## Custom voice gates: stranded clone jobs, the overdue sweep, the oracle on `channel_voice_config_problem` (0121)

0121 (`0121_voice_job_gates.sql`, `docs/CUSTOM_VOICE.md`, "Gates before the owner may enable `NIGHTSHIFT_VOICE_CLONING`") is **live on apply**:
it **replaces two live functions on their latest bodies, verbatim plus marked additions**, and adds three. It writes no row, alters no table,
trigger, policy or table grant, grants nothing to anyone who had nothing, and does **not** grant `request_voice_clone` or touch
`NIGHTSHIFT_VOICE_GATE_STRICT`. Numbered 0121 because 0119 and 0120 are merged and 0118 is unused (no open pull request adds a migration).

- **Replaced on their latest bodies:** `claim_voice_job()` (0117's body, character for character, plus ONE marked block: **G2**, a clone job
  whose profile is deleted or rejected is ended once as `cancelled` / `expired` with the word `profile_not_pending`, and its purge /
  provider deletion is queued, so a job a worker parked and the owner then deleted can no longer stay queued and block
  `purge_voice_records`, and with it the deletion of an account or an organization) and `channel_voice_config_problem()` (now a wrapper:
  0117's body lives on unchanged as `channel_voice_config_problem_core`, callable by nobody). A `DO` block at the top raises if either live
  body is not 0117's (md5 with white space collapsed) or 0121's own, or if one of the three new names already holds another body.
  Re-running 0117 afterwards puts 0117's two bodies back: re-apply 0121 after it (the lab tests that replay 0117 do).
- **Added, service role only:** `voice_requeue_overdue(p_older_than interval default '3 hours')` (G3: failed purge and provider-deletion jobs
  back in the queue with their attempts reset; at most 20 a call, 1 hour to 30 days in plain seconds (no months), never a clone, never where
  the work must not run; a racing delete skips that row) and
  `voice_overdue_report()` (counts and ages in closed fields, no ids).
- **The oracle, narrowed (not closed).** A signed-in user could ask `channel_voice_config_problem` about any channel and any 20-character id and
  learn whether the id is somebody's clone. The exact answer now goes to the service role (the Actions pre-flight) and to the channels guard;
  any other caller is asked one voice key at a time (so one key's answer never depends on, or reveals, the other) and gets the truth only as
  a member of the channel's organization and only about a voice that is theirs or was requested in that organization; otherwise the answer an
  id that is no voice gets. **Residual:** the entry guards (Studio tts, render jobs, `agent_config` writes) still refuse a clone the writer may
  not use, so any signed-in user with a workspace of their own can still confirm a known id through them. It is a decision for the migration
  that grants `request_voice_clone`; `docs/CUSTOM_VOICE.md` says so. No timing claim is made.
- **Python moves with the database.** `tools/voice_worker.py --sweep` (exit 0 nothing overdue, 1 something is, 2 the database could not
  answer) is the one caller of the two new functions; **nothing starts it**. `purge_sample` also sweeps a deleted profile's labelled voices
  now. Both are harmless before the file is applied (`--sweep` exits 2 and says the functions are not available).
- **Apply as ONE transaction** (SQL editor, `apply_migration`, or `psql --single-transaction -v ON_ERROR_STOP=1`).
- **Undo.** `docs/sql/rollback_0121_voice_job_gates.sql` (owner-applied; refuses a body it has not seen, puts 0117's two bodies back byte for
  byte with their grants, drops the three functions; a queue row already ended stays ended). The lab applies it and re-applies 0121.
- **Is it working?** The verify block at the bottom of the file (every column true), and `select public.voice_overdue_report();`.
- **Review.** Needs the independent security review before merge: it changes who may learn that a voice id exists, and it makes the queue
  function every worker calls end rows on its own.

## Series Factory: the format-template carrier (0122)

0122 (`0122_series_template_carrier.sql`, `docs/SERIES_FACTORY.md`, "Format templates") is **live on apply**: it adds one nullable column, **replaces
three live functions on their latest bodies (0120's), verbatim plus marked lines**, and **replaces one callable** (the seven-argument
`request_series_plan` is dropped, an eight-argument one is created). It **grants nothing to anyone**: `request_series_plan` is callable by nobody before
and after, `tests/test_series_template_migration.py` and the lab fail if any migration grants either signature. It writes and rewrites no row, calls no
provider and does not touch credits, holds, publishing or privacy. Numbered 0122 because 0121 merged last and no open pull request adds a migration
(checked with `gh api` when the PR was opened: the open #602 and #606-#609 touch nothing under `supabase/`); 0118 is still unused.

- **The carrier.** `series_plans.template_id text null`, `CHECK (template_id is null or template_id in ('myth_vs_fact', 'top5_countdown',
  'one_question_one_answer'))`, frozen with the other terms by `series_plans_terms_frozen` (0120's body plus one line). The three words are also in the
  request function and in the params validator; a fourth format is a new migration.
- **Replaced, md5-pinned (white space collapsed), refusing any other live body:** `render_job_params_valid` (an optional `template` key: a string of the
  closed list, on a `series_plan` job only; `is distinct from`, so a NULL kind cannot slip past), `render_jobs_payment_guard` (two lines in the series-plan
  block: the job's `template` must equal the plan's `template_id`), `series_plans_terms_frozen`. The live values to read BEFORE applying are in
  `docs/SERIES_FACTORY.md` and in the file's header, with the query.
- **A new signature is a new function.** `request_series_plan(..., p_template text default null)` is 0120's body plus the validation (exactly one of the
  three words, or NULL; not trimmed or defaulted; judged after the caller is known), the format in the idempotency hash (only when there is one: a request
  without a format hashes exactly as under 0120, so a plan made before the migration still replays; a replay with another format is
  `idempotency_conflict`), the column, and the job param. It is **revoked from public, anon, authenticated and service_role** right after it is created
  and the old signature is dropped (no `cascade`). The file refuses to drop the old one unless it is 0120's body **and** executable by nobody (a NULL ACL
  counts as executable: the default includes public), so a grant made by hand stops the apply instead of being dropped silently.
- **The end state is asserted inside the transaction** (the last block): the three bodies and the new function hold this file's text, the old signature
  is gone, the new one is executable by nobody, the column is nullable text and the check is validated. Any failure rolls the whole file back.
- **Python and TypeScript move with it.** The worker reads `template_id` (and, if PostgREST says the column does not exist, reads again without it: no
  format is then a fact); `plan_series(..., template=...)`; the form sends `p_template` only when a format is picked, so it works before and after the
  migration. `run_request.ALLOWED_PARAMS` does **not** gain `template` (only a planning job carries it; `tests/test_series_template_migration.py` compares
  the database's allowed list with it).
- **Re-running 0120 afterwards** is refused by its own drift guard (its two bodies are now 0122's): take 0122 off first with its rollback, as the lab tests do
  (`sec_db.take_off_0122`), then put it back.
- **Apply as ONE transaction** (SQL editor, `apply_migration`, or `psql --single-transaction -v ON_ERROR_STOP=1`).
- **Undo.** `docs/sql/rollback_0122_series_template_carrier.sql` (owner-applied): refuses if any of the four live bodies is not 0122's, if any plan asked for
  a format (dropping the column would lose that record), or if any queue row carries a `template` param (the 0120 validator would refuse the row on its next
  update: a CHECK is evaluated again on every update). Otherwise it puts 0120's three bodies back byte for byte, re-creates the seven-argument function
  revoked from every API role, drops the eight-argument one, and drops the check and the column. The lab applies it, compares with a database that never had
  0122, and applies 0122 again.
- **Is it working?** The verify block at the bottom of the file (every column true).
- **Review.** Needs the independent security review before merge, and a person reading the live hashes first: it replaces the payment guard every queued
  run passes through, and it drops and re-creates a function.

## Series Factory: per-person and platform-wide plan caps (0127)

0127 (`0127_series_plan_caps.sql`, `docs/SERIES_FACTORY.md`, "Plan caps") is **live on apply and dark**: it **replaces one function** (the eight-argument
`request_series_plan`, on 0122's body plus lines marked `-- 0127`, md5-pinned: BEFORE `e38342a6c8511d5eadb1f99ab38fb6aa`), adds one table
(`series_plan_cap_settings`, one row, closed to every API role) and two internal trigger functions. It **grants nothing**: `request_series_plan` is executable by
nobody before and after, and the file refuses to run, and its end state refuses to commit, if it is executable by public or an API role. It writes no plan row,
calls no provider and touches no credit, hold, publishing or privacy rule. Numbered 0127 as asked; no open pull request adds a migration (checked with `gh api`
when the PR was opened: the open #624-#629 touch nothing under `supabase/`); 0123 is unused and left to the migration that reserved it.

- **What it enforces (finding F4).** 3 plans per person (any organization) and 30 for all organizations per rolling 24 hours, after the organization's 5 (0120),
  counted from `series_plans`; failed and expired plans count (even an expired one whose queue row was cancelled and spent no model call, so a worker outage or a spent Gemini quota burns the caps); a replay of an accepted press is never refused. A refusal raises NS429 with the closed message
  `series_user_cap` (detail `limit=3 per 24 hours`) or `series_global_cap` (no detail) and rolls everything back. Both are counted under one platform-wide advisory lock, always taken
  after the organization's (0120).
- **The owner's numbers.** `select * from public.series_plan_cap_settings;` (expects `3, 30`); change them in the SQL editor, no deploy; pause planning with `global_daily_cap = 0`, not `user_daily_cap = 0` (a person cap of 0 tells someone who made no plan that they reached their limit); a fractional value such as 2.5 is accepted and rounds to 3. A missing row
  reads as the defaults. A replay never undoes the owner's edit (`on conflict do nothing`).
- **Order with 0124 / 0125 / 0126:** none replaces an object the others touch; the lab applies the four in four orders and compares the end states.
- **Re-running 0122 afterwards** is refused by its own drift guard (its `request_series_plan` body is now 0127's): take 0127 off first with its rollback, as the lab
  tests do (`sec_db.take_off_0127`; `sec_db.take_off_0122` does it for you).
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`; the last block asserts the end state.
- **Undo.** `docs/sql/rollback_0127_series_plan_caps.sql` (owner-applied): refuses a body that is not 0127's and refuses while the function is granted; puts 0122's
  body back byte for byte; drops the table (copy the numbers out first). Run it BEFORE `rollback_0122_series_template_carrier.sql`.
- **Review.** Needs the independent security review before merge, and a person reading the live hash first.

## Edited pictures remember their original (0128)

0128 (`0128_upload_parent_asset.sql`, `docs/IMAGE_EDITOR.md`, "The link to the original") is **live on apply and dark**: it adds one nullable column
(`media_uploads.parent_asset_id`, `ON DELETE SET NULL`, a partial index), **adds one function overload** (the seven-argument `request_upload`, a thin wrapper
over 0051's six-argument one) and **replaces one function** (`register_asset`, on 0051's body plus eleven lines marked `-- 0128`, md5-pinned: BEFORE
`233cdbb722c76a434f08d929bafa4e27`). It adds no table, no policy and no grant on any table; the new overload is granted to `authenticated` only (as 0051's two),
revoked from public, anon and service_role. Nothing happens until the image editor is switched on (`NIGHTSHIFT_IMAGE_EDITOR`): the only caller that names a parent.

- **What it enforces.** The parent of an upload must be a live image of the organization uploaded to, and the upload itself an image (by the kind `request_upload` derives; also re-checked on what the worker found in the file), checked after sign-in and membership; every refusal
  (another organization's, deleted, a video, made up) is the same P0002 `reason=parent_not_found`. `register_asset` takes the parent from the ticket
  only, re-checks it (a parent gone = no link, never a failed upload) and the worker's own same-organization check (0038) still runs.
- **Roll-out.** Either order with the Command Center and the worker (the Command Center feature-detects the overload and saves without a link otherwise).
- **Drift guard.** Refuses (changes nothing) if the live `register_asset` is neither 0051's body nor its own; the last block asserts the end state.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`.
- **Undo.** `docs/sql/rollback_0128_upload_parent_asset.sql` (owner-applied): refuses a body that is not 0128's and refuses while a ticket in flight carries a
  parent; puts 0051's body back byte for byte; drops the overload, index, constraint and column. Links already written on `media_assets` stay.
- **Review.** Needs the independent security review before merge, and a person reading the live `register_asset` hash first.

## An export in another frame (0129)

0129 (`0129_editor_export_frame.sql`, `docs/MULTI_RATIO_EXPORT.md`) is **live on apply and dark**: it adds three nullable columns to `editor_exports`
(`frame_preset`, `frame_width`, `frame_height`, one CHECK), **adds one internal function** (`editor_export_frame(text)`, the closed list of export formats,
no API role may call it) and **adds one function overload** (the three-argument `request_editor_export`: 0054's two-argument body plus the lines marked
`-- 0129`). It **replaces no function**: the two-argument `request_editor_export` is not touched (md5 `6d37b4d75092708981c28a56879c89b4` before and after).
It adds no table, no policy and no grant on any table; the overload is granted to `authenticated` only (as the two-argument one), revoked from public, anon
and service_role. Nothing calls it until `NIGHTSHIFT_MULTI_RATIO_EXPORT` is on.

- **What it enforces.** The frame must be an id of the database's own list (the five of `schemas/export_presets.json`; a pin test compares them), looked at
  only after sign-in and membership; anything else is NS400 `invalid_frame`. Width and height on the row come from the list, never from the caller. Every
  gate of 0054 is there in 0054's order; each frame is one export against the organization's three in flight and twenty a day.
- **The one rule with a new shape.** "One export at a time per project" is, in the new overload only, "one at a time per project per frame size" (a plain export in flight has the size of the document it copied, so a format of the project's own size is refused beside it).
- **Roll-out.** Either order with the Command Center and the worker; see `docs/MULTI_RATIO_EXPORT.md`. The switch goes on only when both run this version.
- **Drift guard.** Refuses (changes nothing) if the live two-argument `request_editor_export` is not 0054's body (the overload is a copy of it), or if a
  three-argument overload or an `editor_export_frame` that is not its own already exists; the last block asserts the end state.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`.
- **Undo.** `docs/sql/rollback_0129_editor_export_frame.sql` (owner-applied): refuses a body that is not 0129's and refuses while an export in flight carries a
  frame; drops the overload, the list, the check and the three columns. Exported videos stay in the library.
- **Review.** Needs the independent security review before merge, and a person reading the live two-argument `request_editor_export` hash first.

## The operator's Customers page (0138)

0138 (`0138_operator_customers.sql`, the Command Center's `/{channel}/customers`) is **live on apply and read-only**: it **adds three
functions** and nothing else (no table, column, index, policy or trigger; it **replaces nothing**). `operator_customer_totals()` (people,
workspaces, active workspaces, credits spent / bought / granted, paid in USD with other currencies counted apart, outstanding balances),
`operator_customer_daily(p_days)` (1-90 UTC days: new workspaces, credits spent, workspaces that spent) and
`operator_customer_accounts(p_search, p_sort, p_limit, p_offset)` (one page of at most 100 workspaces, searched as plain text, sorted
and paged in the database, `total_count` on every row). Each is a stable SECURITY DEFINER with `search_path = public, pg_temp` that
refuses anyone but a signed-in platform owner/admin (42501 "not available") before it reads anything or looks at an argument;
granted to `authenticated` only, revoked from public, anon and service_role. The operator's own workspace (`default_org_id()`) is in
none of the numbers.

- **What "spent" means.** Ledger `capture` rows less positive `refund` rows (a failed paid download given back, 0030). A `reserve` is a
  hold and a `release` gives it back: neither is a spend, and an open hold is `reserved`, not spent. A negative `refund` takes back a
  refunded purchase and is not a spend either.
- **Drift guard.** Refuses (changes nothing) if one of the three names exists with a body that is not this file's; the last block
  asserts each body by md5, the grants, definer, stability and the fixed search_path. Pins: totals `938bff459e8a932a7ffc9d078f0d6137`,
  daily `e80c9c92cf7a1625f02bc585ed549660`, accounts `ed07a54a29c3110fcf03531c79c47984`.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`. Takes no lock on any table beyond reading the catalog.
- **Undo.** `docs/sql/rollback_0138_operator_customers.sql` (owner-applied): refuses a body that is not 0138's, drops the three functions.
  Nothing else is touched by either file.
- **Tests.** `tests/test_operator_customers_migration.py` (the file, pinned) and `tests/security/test_sec_operator_customers.py` (the lab:
  every customer, anon and the service role refused, refused before argument checks, the exact figures of a seeded world — captures
  counted, released and open holds not, a refunded download subtracted, a retried webhook one payment, EUR never dollars, the operator's
  workspace left out — search as plain text, sorting and paging, bad arguments, read-only, a replay, the rollback, the drift guards).
  The lab's `auth.users` stand-in gained GoTrue's `last_sign_in_at` column.
- **Numbering.** 0138, after 0136 (applied live) and 0137 (Character Studio, #686): it names nothing of theirs, and 0137 alters no table
  these functions read. The numbering tests of 0127, 0131 and 0133 list both 0137 and 0138 as reviewed.

## Exports up to 1080p, sold by the started minute (0136)

0136 (`0136_editor_export_paid_1080p.sql`, `docs/HIRES_EXPORT.md` "Up to 1080p") is **live on apply and changes nothing until the owner
sets the price**: it **adds** one nullable column, `credits_per_minute_1080p`, to 0132's price row (seeded NULL = free) and one internal
function (`editor_export_price_1080p()`, nobody's), and **replaces** 0132's three `request_editor_export` bodies, `quote_editor_export`,
`editor_export_hires_terms` and the price trail with 0132's bodies plus only marked `-- 0136` lines (a pin test strips them and compares).
While the price is set: the two- and three-argument calls refuse `export_needs_quote` (NS409), and the four-argument one sells a free id
or `project` (the project's own frame up to 1080p) with the paid tiers' quote, hold (charge raised to job_minimum) and capture of the
charge. One lock order in every overload (0054's). It also **adds** `editor_doc_rendered_length(jsonb)` with its helpers
`editor_ms(double precision)` and `editor_jnum(jsonb)` (nobody's). These give the length the renderer renders, speed curves included,
to the millisecond. The paid request and the quote use it for the length and the minutes, so 0132's `hires_speed_curve` refusal goes. A
curve the renderer would refuse is `invalid_speed_curve`. The quote says `curve_sold: true`.

- **Drift guard.** Refuses (changes nothing) if a function it replaces is neither 0132's body nor its own, or if 0132's money, settle,
  guard or list is not 0132's. The last block asserts every body by md5, the grants and the column.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`.
- **Undo.** `docs/sql/rollback_0136_editor_export_paid_1080p.sql` (owner-applied; before 0132's rollback): puts 0132's bodies back
  byte for byte, drops the column and the three length functions. 0132's lab tests take 0136 off first where they test 0132's file (`sec_db.take_off_0136`).
- **Tests.** `tests/test_editor_export_paid_1080p_migration.py` (the file, pinned), `tests/security/test_sec_editor_export_paid_1080p.py`
  (NULL = free, price 1 with job_minimum 30: hold 30, capture 1, release 29; legacy refusals; races across every entry point; the file),
  `tests/security/test_sec_editor_rendered_length.py` (2,260 seeded documents: SQL length = Python `duration_s` to the ms, the same minutes).
- **Numbering.** 0134 and 0135 are reserved by other work; 0136 names nothing of theirs.
- **Prices.** Owner-approved 2026-11-11: 1 up to 1080p (and 3 / 5 for 1440p / 4K). Set them only after the deploy and with both
  export switches on in the web and the worker.

## 1440p and 4K exports, sold by the started minute (0132)

0132 (`0132_editor_hires_export.sql`, `docs/HIRES_EXPORT.md`) is **live on apply and sells nothing**: both prices are seeded NULL ("not on sale").
It **adds** four nullable columns to `editor_exports` (`quoted_credits` = the charge, `held_credits` = the hold, `credit_ref`, `charged_credits`) and one
CHECK (`editor_exports_hires_terms`: a frame above 1080p carries its quote, the hold is never below the charge, 300 s / 180 s at most, 4K at most
30 fps), **replaces** 0129's CHECK `editor_exports_frame_shape` (ceiling
2560x1440 → 3840x2160) and 0129's list `editor_export_frame(text)` (its five rows plus four paid ones, value for value `schemas/export_presets.json`),
and **adds** one table (`editor_export_hires_prices`, one row, closed to every API role, changed in the SQL editor only, a change leaves a
`security_events` row), a settling trigger on `editor_exports`, three internal functions, `quote_editor_export` and the four-argument
`request_editor_export` (both granted to `authenticated` only). It **replaces** the two- and three-argument `request_editor_export` with 0054's /
0129's bodies plus only the marked lines that refuse above 1080p (`hires_needs_paid_export`: a project whose own frame is bigger, or a paid frame
of the list); an export up to 1080p is free and what it was. **Not behind the switch**: from apply, a project whose own frame is above 1080p is
not exported free (0 such projects on 2026-11-11).

- **The money.** The charge is the price per started minute × the minutes, with no `job_minimum` floor; the hold is the charge raised to
  `job_minimum` (0133's rule). Hold at request (after every limit) via `creative_platform_reserve`, started at once; capture the charge when done
  (the rest of the hold goes back), release when failed,
  on every path that ends an export (one BEFORE UPDATE OF status trigger), once. A hold that is gone when the worker claims the export fails it
  (`credits_released`) before any render. A held paid export takes one of the plan's parallel runs (`parallel_runs`).
- **Drift guard.** Refuses (changes nothing) if the two- or three-argument `request_editor_export` is neither 0054's / 0129's body nor its own, if the list is
  neither 0129's nor its own, or if any name it creates exists with another body. The last block asserts every body by md5, every grant, the
  checks, the trigger, RLS and the price row.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'` (two constraints are dropped and added on `editor_exports`).
- **Undo.** `docs/sql/rollback_0132_editor_hires_export.sql` (owner-applied; before 0129's rollback): refuses a body that is not 0132's and refuses
  while a paid export is queued or rendering; puts 0129's list, 0054's and 0129's request bodies back byte for byte and 0129's frame check (NOT
  VALID while a finished 4K row exists).
- **Prices.** Set them only once `NIGHTSHIFT_HIRES_EXPORT` is on in the media worker (`docs/HIRES_EXPORT.md`, "The switch and the roll-out").
- **Tests.** `tests/test_editor_hires_export_migration.py` (the file, pinned; the caps of SQL, Python and TypeScript compared),
  `tests/security/test_sec_editor_hires_export.py` (the lab: grants, refusals, hold / capture / release, idempotency, NULL price, caps, a race,
  the rollback). 0129's lab tests take 0132 off first where they replay 0129 (`sec_db.take_off_0132`).
- **Numbering.** 0133 (the brand scan, #674) was merged while 0132 was in review; neither names anything of the other, and the two numbering
  tests (`tests/test_ads_factory_migration.py`, `tests/test_series_plan_caps_migration.py`) list both.

## Saved agent plans (0130)

0130 (`0130_agent_workflow_drafts.sql`, `docs/product/AGENT_NODE_BUILDER.md`) is **live on apply and dark**: it adds two tables
(`agent_workflow_drafts`, `agent_workflow_draft_versions`, one owner-only SELECT policy each, RLS on, no write grant to any API role) and two
SECURITY DEFINER functions with an empty search_path (`save_agent_workflow_draft`, `delete_agent_workflow_draft(uuid)`), granted to `authenticated`
only and revoked from public, anon and service_role. It **replaces no function** and touches no older table, grant or policy. Plans belong to one
person (no organization column); another person's id answers P0002 like a missing one.

- **What it enforces.** Every level of the document has an exact key set and checked JSON types; names and labels are counted raw, must hold a
  visible character and none of the BR-L-120 class; positions are plain integers in bounds; node types come from a closed list; an export needs an
  incoming edge; 150 KB per document, 50 plans per person, the newest 30 versions kept (an older one is pruned in the same locked transaction).
- **Not covered by the switch.** `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` hides the page and routes only; a signed-in person can call both functions
  through PostgREST within those limits.
- **Drift guard.** The last block asserts the end state (grants incl. service_role, RLS, one policy per table, definer + search_path, size CHECK).
- **Apply as ONE transaction.** `set local lock_timeout = '5s'` (the foreign key to `auth.users` takes a SHARE ROW EXCLUSIVE lock there).
- **Undo.** `docs/sql/rollback_0130_agent_workflow_drafts.sql` (owner-applied): refuses a function body that is not 0130's and refuses while any
  plan exists unless its `set local` override line is turned on; drops both functions and both tables.
- **Review.** Independent security review done (two rounds) before merge.

## Ads Factory, Phase 1: brand kits, products, campaigns, concepts (0131)

0131 (`0131_ads_factory.sql`, `docs/ADS_FACTORY.md`) is **live on apply and dark**: it **adds seven tables** (`brand_kits`, `brand_products`,
`brand_product_images`, `ad_campaigns`, `ad_campaign_products`, `ad_concepts`, `ads_factory_cap_settings`), twelve internal functions and ten member functions.
It **replaces nothing** and adds no column, policy, trigger or grant to any existing object. Nothing in the application calls it until `NIGHTSHIFT_ADS_FACTORY`
is on (the page and `/api/ads/*` are a 404 before that), but the ten member functions are granted to `authenticated` on apply: a signed-in editor can call them
through PostgREST while the page is off, within the caps, and rows made that way make the rollback refuse unless told the rows may go. Nothing in it fetches a
site, calls a model, prices, holds or charges a credit, queues a job or publishes.

- **Who may do what.** Members (viewer and up) read their organization's rows (one SELECT policy per table, `accessible_org_ids('viewer')`). No API role holds
  INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on any of the seven; anon holds nothing; service_role holds SELECT on the six content tables only. Every
  write is one of ten SECURITY DEFINER functions (pinned `search_path`), granted to `authenticated` alone, each checking sign-in, membership and the editor role.
  Another organization's id and a made-up id are the same `not_found`.
- **Caps** (`ads_factory_cap_settings`, one row, closed to every API role, changed in the SQL editor, a change leaves a `security_events` row of kind
  `ads.factory.caps`): 5 kits per organization, 20 products per kit, 20 campaigns per organization, 24 concepts per campaign. 0 pauses creating. Counted in the
  database under one advisory lock per organization; a missing row reads as the defaults.
- **Drift guard.** Refuses (changes nothing) if a function of one of its names exists with another body; the last block asserts the end state (every body by md5,
  every grant, RLS, the policies, the checks, the foreign keys, the triggers, the settings row).
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`. Applies in any order relative to 0129 and 0130 (it names no object any migration after 0107 creates).
- **Locks.** No function holds a row lock while it waits for the organization's advisory lock: read the row unlocked, check membership and role, take the
  organization's lock, then lock the row FOR NO KEY UPDATE and read it again (and everything else that decides the write). A row locked first deadlocked against
  a parent delete's cascade or an insert's foreign key check under that lock (40P01); the lab races each pair.
- **Undo.** `docs/sql/rollback_0131_ads_factory.sql` (owner-applied): refuses a body that is not 0131's, and refuses while the content tables hold rows unless
  `set local nightshift.ads_rollback_delete_rows = 'yes'` is given in the same transaction (the rows are what people typed). Drops exactly what 0131 added.
- **Tests.** `tests/test_ads_factory_migration.py` (the file, pinned), `tests/security/test_sec_ads_factory.py` (the lab: tenants, roles, caps, races, the rollback).

## Ads Factory, Phase 2: the brand scan (0133)

0133 (`0133_brand_scan.sql`, `docs/ADS_FACTORY.md` "Phase 2") is **live on apply and dark**: it **adds four tables** (`brand_domains`,
`brand_domain_checks`, `brand_scans`, `brand_scan_settings`), nine internal functions, five member functions and five worker functions. It
**replaces nothing**; its only writes to older tables are `accept_brand_scan_fields`'s into 0131's kits and products, through 0131's
cleaning and caps, and a failed scan's own pictures marked deleted in `media_assets`. The scan is **not on sale** until the owner sets `brand_scan_settings.price_credits` (seeded NULL): `request_brand_scan`
refuses `not_on_sale`. The worker (`tools/brand_scan_worker.py`) does nothing unless `NIGHTSHIFT_ADS_BRAND_SCAN=on`.

- **Number.** 0133: 0132 is reserved by another open pull request (the hi-res export); neither names anything the other adds.
- **Who may do what.** Members read their organization's rows; no API role writes any table; the settings are closed. Five SECURITY DEFINER
  member functions to `authenticated` (each checks the editor role; `quote_brand_scan` any member), five worker functions to
  `service_role` only, nine helpers to nobody.
- **Money.** The price is charged as set (exempt from `job_minimum`); a request holds `greatest(price, job_minimum)` (`creative_platform_reserve`;
  reserve_credits is not changed), the worker's finish captures exactly the price and the rest of the hold is released, every failure and the
  stale sweeps release it; the confirmed price (`p_max_credits`) only refuses a higher one; an idempotent replay holds nothing twice.
- **Caps.** One scan in flight per organization (unique index); one organization's share per 24 hours, `org_daily_scans` (20) and
  `org_daily_checks` (200; safety defaults, not yet owner-approved), refused `org_daily_limit`; `platform_daily_scans` (500) and
  `platform_daily_checks` (5000) per 24 hours under a platform lock after the organization's; 10 domains per organization; one check per
  domain per 15 s. A failed scan's stored pictures are deleted from the library (the one write to `media_assets`: `deleted_at`).
- **Drift guard.** Refuses a function of its names with another body; the last block asserts the end state (bodies, grants, RLS, policies,
  checks, the index, the triggers, the settings row).
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`. Needs 0131 (its checks use 0131's text rules).
- **Undo.** `docs/sql/rollback_0133_brand_scan.sql` (owner-applied; run it BEFORE 0131's): refuses a body that is not 0133's, a scan in
  flight, and rows unless `set local nightshift.brand_scan_rollback_delete_rows = 'yes'`. Kits and products accepted from a scan stay.
- **Tests.** `tests/test_brand_scan_migration.py` (the file, pinned), `tests/security/test_sec_brand_scan.py` (the lab: roles, the price,
  the domain rule, holds / captures / releases, idempotency, caps and races, the result checks, accepting, the rollback).

## The brand scan's follow-up (0134)

0134 (`0134_brand_scan_followup.sql`, `docs/ADS_FACTORY.md` "Known limits (Phase 2)") **replaces one function**, 0133's
`brand_scan_fail_locked(uuid, text)`. A failed scan no longer deletes a picture that a brand kit (`brand_kits.logo_asset_id`) or a product
(`brand_product_images.asset_id`) references. The scan's pictures are locked FOR UPDATE first, so a kit or product write that is still
open is waited for, and the delete is a statement of its own, which reads the kits and products after that wait.
- **Number.** 0134: 0132 is taken by an open pull request (the hi-res export), and 0137 is reserved for character studio.
- **Guards.** The body must be 0133's (`67e8ee83bde9ec4512a3d6135c9c07ee`) or 0134's own (`fd10914ccff5aa66264ab96265e59c38`, a replay).
  The columns of 0131's tables that reference `media_assets` must be exactly those two, or the file refuses. The end state checks the
  body, that no API role can execute it, that it is SECURITY DEFINER with a pinned search_path and has no overload, and that 0133's three
  callers still reach it.
- **Lock order.** It takes no advisory lock (0131's rule). The picture row locks come after the scan row lock its callers hold, the same
  order `accept_brand_scan_fields` uses.
- **No price.** It does not touch `brand_scan_settings`. The price is set at go-live, after the worker runs.
- **Undo.** `docs/sql/rollback_0134_brand_scan_followup.sql` puts 0133's body back, byte for byte. Run it BEFORE 0133's rollback, which
  refuses any body but 0133's.
- **Tests.** `tests/test_brand_scan_followup_migration.py` (the file, pinned) and `tests/security/test_sec_brand_scan_followup.py`
  (the lab: every failure path, each filter, a real concurrent kit write, the guards, a replay, the rollback chain). Lab tests that
  replay or roll back 0133 take 0134 off first (`sec_db.take_off_0134`).
## Character Studio: priced character swaps, the consent trail, the gallery (0137)

0137 (`0137_character_studio.sql`, `docs/CHARACTER_STUDIO.md`) is **live on apply and dark**: it **adds six tables** (`character_swap_models`,
`character_swap_settings`, `character_swap_consents`, `character_swap_jobs`, `character_swap_templates`, `character_swap_template_samples`), twelve
internal functions, four member functions and four worker functions. It **replaces nothing** and names no object of the Ads Factory or of
`creative_jobs`. Nothing is **on sale** until the owner sets `character_swap_models.credits_per_usd` per model (seeded NULL): `request_character_swap`
refuses `not_on_sale`. The worker (`tools/character_swap_worker.py`) does nothing unless `NIGHTSHIFT_CHARACTER_STUDIO=on`; the page and the routes are a 404.

- **Number.** 0137, after 0136 (#685, applied live). It was first numbered 0135 (0134's and 0136's headers still say 0135 is reserved for it) and
  renumbered with the same body, so it applies after 0136 instead of out of order; 0135 stays unused. None of 0132-0136 names anything 0137 adds, and
  0137 names nothing of theirs (tests/test_character_studio_migration.py checks it). The numbering tests of 0127, 0131 and 0133 list 0137 as
  reviewed; 0137's own does not forbid later numbers.
- **Who may do what.** Members (viewer and up) read their organization's jobs and consents; any signed-in person reads the gallery; the models and the
  settings are closed to every API role. Four SECURITY DEFINER member functions to `authenticated` (quote any member; consent, request and cancel an
  editor), four worker functions to `service_role` only, the helpers to nobody. The samples script's service key may insert and update a sample row.
- **Money.** The charge is the database's (the vendor's USD per clip second at the resolution x whole seconds x credits_per_usd, rounded up to the cent);
  a request holds `greatest(charge, credits_round_up(job_minimum))` (`reserve_credits` and `job_minimum` unchanged), the finish captures exactly the
  charge (`capture_credits(ref, charge, false)`), every failure, a cancel and the stale sweeps release it; `p_max_credits` is compared with the charge and
  refuses NaN and the infinities; an idempotent replay holds nothing twice. The vendor task id is recorded before polling; a finish without one is refused.
- **Consent.** Append-only trail (ENABLE ALWAYS triggers, no foreign key), five declarations, one consent per job, within the hour, of the same person,
  model, video and pictures. A keyword screen on the prompt (real or public people, minors). Seedance only for the organization's own generated
  BytePlus clip of the last 30 days.
- **Caps.** One job in flight per organization (unique index); 10 per organization and 200 per platform per 24 hours; 20 in flight on the platform;
  100 consents per organization per day. Counted under the organization's lock, then the platform's (0127's order).
- **Locks (0131).** Read unlocked, check the role, take the organization's advisory lock, then lock rows (the inputs FOR SHARE, a job FOR NO KEY UPDATE)
  and read them again.
- **Drift guard.** Refuses a function of its names with another body; the last block asserts the end state (bodies, grants, RLS, policies, checks, the
  index, the triggers and their ENABLE ALWAYS, the seeded rows).
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`.
- **Undo.** `docs/sql/rollback_0137_character_studio.sql` (owner-applied): refuses a body that is not 0137's, a job in flight, and rows people made
  unless `set local nightshift.character_swap_rollback_delete_rows = 'yes'`. Outputs stay in the library.
- **Tests.** `tests/test_character_studio_migration.py` (the file, pinned), `tests/security/test_sec_character_swap.py` (the lab: grants, cross-org,
  consent, the money ledger at job_minimum 30, caps, the worker's task rule, races, the rollback and re-apply, touching nothing else).

## The owner's model switch (0124)

0124 (`0124_model_switch.sql`, `docs/MODEL_SWITCH.md`) is **live on apply and dark**: it replaces five functions that exist on the live
database (`sellable_models`, `creative_price`, `advance_creative_job`, `api_creative_model_ok`, `api_creative_refusal`) and one RLS policy
(`model_registry_select`), each on the body the repo says is latest (md5 drift guard), and adds four tables and fifteen functions (eleven callable, four trigger functions).

- **Number.** 0124: 0122 is the Series Factory template carrier (merged, #610); 0123 belongs to the owner model-API-keys migration (branch
  `claude/owner-model-api-keys`, not merged when this was written; no object in common). A gap is normal (0113 and 0118 are unused).
- **Is it off?** `select enforced, auto_suggest from public.model_availability_settings;` must read `false, false`. While `enforced` is false
  `model_is_available()` answers true for every model, the replaced functions return what they returned, and `owner_set_model_switch`
  refuses (`not_enforced`). The seed is `on conflict do nothing`: a replay never undoes what the owner set.
- **Wired?** Not until the repository variable `NIGHTSHIFT_MODEL_SWITCH` is `on` (the Models page's Switches view, `POST /api/owner/model-switch`,
  and the queue worker's pre-spend gate for channel runs). The two are separate on purpose.
- **Undo.** `update public.model_availability_settings set enforced = false;` for behaviour; to remove the objects
  `docs/sql/rollback_0124_model_switch.sql` (owner-applied; refuses a body it has not seen; copy the log out first, it drops it).
- **Apply as ONE transaction.** The file refuses a half-applied state and takes `set local lock_timeout = '5s'`.
- **Review.** Needs the independent security review before merge: `docs/MODEL_SWITCH.md`, "What the independent security review must verify".
## A model past its vendor's announced shutdown date is not sold (0125)

Google's deprecations page (ai.google.dev/gemini-api/docs/deprecations, read 2026-10-25) lists `veo-3.1-generate-preview`, `-fast-` and `-lite-` with shutdown
2026-10-22 and `gemini-2.5-flash-image` with 2027-03-15. Google calls every date on that page "the earliest possible", so a date is neither "dead" nor "safe": it
is the day Nightshift stops selling the model unless a probe says otherwise.

- **Live on apply, and not dark.** 0125 replaces two functions that exist on the live database (`sellable_models`, `creative_price`) on **0124's bodies plus one
  line each**, and adds one internal function. A model with no `shutdown` in its spec behaves exactly as before; a model whose spec carries a date that has come
  (the three Veo 3.1 previews, once `tools/probe_models.py --sync` has copied the registry's dates) stops being offered and quoted at once.
- **Number and order.** It is written on 0124's bodies (0124 and 0125 both replace these two functions, and 0124 pins their md5), so it **refuses to apply
  without 0124** and carries the same md5 drift guard (0124's body or its own, else it refuses). 0123 is not used by this file.
- **The field.** `shutdown` in `schemas/model_registry.json` (`on`, `source_url`, `as_of`, optional `replacement`), copied into `model_registry.spec` by the sync like every
  other static fact. A model with no announced date has no `shutdown`; the validator rejects a date that is not a calendar day.
- **The guard.** `public.model_past_shutdown(spec)` is true from `spec.shutdown.on` (the UTC date, `(now() at time zone 'utc')::date`, whatever the session's `TimeZone`) on, and **fails closed**: a `shutdown` that is not an object, or
  a date that is not `YYYY-MM-DD`, reads as past. It is internal (revoked from every API role). The list hides the model and a quote by name is refused
  (`model_not_sellable`). `tests/test_model_shutdown.py` removes the two added lines and compares the rest of each body byte for byte.
- **Not changed.** No price, no availability, no `credit_prices` row, no gate, no switch (0124's `model_is_available` is still asked first).
- **Re-opening an id** that a probe shows still answers is one edit: move its `shutdown.on` in the registry and sync. The Veo client in `modules/video_providers.py`
  reads the same date, so the sale and the legacy B-roll path never disagree.
- **Undo.** `docs/sql/rollback_0125_model_shutdown.sql` (owner-applied; refuses a body that is neither 0125's nor 0124's; puts 0124's two bodies back byte for
  byte, drops the helper). Run it **before** `rollback_0124_model_switch.sql`, which refuses a body that is not 0124's. The security lab takes 0125 off
  (`sec_db.take_off_0125`) wherever it replays 0124.
- **Apply** after 0124, as one transaction. `tests/security/test_sec_model_shutdown.py` runs both functions on a real PostgreSQL at the boundary day and with unreadable
  dates, the drift guard, the rollback and the refusal without 0124.

## Operator preview of a hidden model (0139)

0139 (`0139_operator_preview.sql`) lets the platform operator try a hidden model in the site's own Studio before it is offered to anyone. It is
**live on apply and dark until the registry says so**: it replaces ONE function (`creative_price`, on 0125's body plus six hunks) and adds two,
and nothing changes for anyone until a registry entry carries `"operator_preview": true` and `tools/probe_models.py --sync` copies it.

- **The rule** (`creative_operator_preview`, internal). A model that is not beta or ga is quoted ONLY when all hold: it is `hidden` (never
  `disabled`), its spec says `"operator_preview": true` (the JSON value), the caller is a platform owner or admin, and the organization is the
  credits-exempt one and the caller is its member. Every other check still runs in the same order: verified by a real probe, not past a
  shutdown date (0125), not switched off (0124), capability and options listed. Everyone else gets today's answer, `model_not_sellable`.
- **Money: the normal path.** `quote_creative_job` and `create_creative_job` are not replaced. The exempt organization already holds and pays
  nothing (`reserve_credits` answers exempt, `credit_ref` stays NULL, the finish captures nothing), and only a platform admin may start a job
  there. A preview with a `credit_prices` row is quoted at it; one without is quoted at the vendor's cost from the registry
  (`pricing.provider_usd_per_unit` x 100, no margin, floored at `job_minimum` like every quote) as the job's record only. No price row is
  written, so nothing goes on sale. A model priced by variant or with no stated cost stays `unpriced`. The quote carries `"preview": true`.
  A plan entitlement (`models_image:basic` ...) is not asked of a preview: the exempt organization has no plan.
- **The list.** `operator_preview_models(p_org)` (granted to `authenticated`) answers the same models with the public half of spec, and no
  rows to anyone else. The create page asks for it only for the platform operator in the operator's organization and passes the result to
  the generate panel alone, with a "Preview" badge (uz "Sinov", ru "Тест"). `sellable_models`, the API's model check and the router are
  unchanged: a preview is never offered through the API, MCP, the Assistant or an automatic pick.
- **Turning one on.** Set `"operator_preview": true` on the entry, sync, and probe it once by name (`tools/probe_models.py --model <id>`: a
  hidden, terms-gated model is skipped by `--all`). Until a probe has succeeded the preview is refused like any unverified model.
- **Drift guard and end state.** The live `creative_price` must be 0125's body (`e0c4a7806642086398558cf322c95a0d`) or 0139's
  (`ae28b700503542701ee0ac63a67df36e`); the two new names must be 0139's if they exist (`creative_operator_preview`
  `ca8654e202cf46029350aaa3111c4c5d`, `operator_preview_models` `525ba27b989bcb7d3d005f4a4972448f`). The last block asserts bodies, grants
  and the pinned search_path. Apply as ONE transaction.
- **Order.** 0139 sits on 0125's `creative_price` and refuses to apply without it. 0125's rollback refuses 0139's body: run
  `docs/sql/rollback_0139_operator_preview.sql` first (it puts 0125's body back byte for byte and drops the two functions). The lab takes 0139
  off wherever it replays or rolls back 0125 (`sec_db.take_off_0139`, `sec_db.ON_0125`).
- **Tests.** `tests/test_operator_preview_migration.py` (the hunks, the hashes, the rollback, the grants), `tests/security/test_sec_operator_preview.py`
  (a non-admin and an admin in a customer's organization are refused; the operator is quoted at cost and holds nothing; every other quote is
  byte for byte 0125's; the drift guard, the rollback and the order), `command-center/tests/operator-preview.test.tsx` (the badge, the list).

## A model blocked by country cannot be put on sale (0142)

0142 (`0142_country_block_before_sale.sql`) is **live on apply** and changes no row: it adds one CHECK to `model_registry`,
`model_registry_countries_before_sale`: `availability not in ('beta','ga')` or `spec.blocked_countries` is absent, JSON null or `[]`.

- **Why.** The country check of `docs/GEO_BLOCK.md` runs in the Next.js routes only. `create_creative_job` (0075),
  `start_workflow_run` (0073) and `advance_workflow_run` (0074) are granted to `authenticated`, so a signed-in user can call them
  directly and skip it. Until the database refuses by country itself (a follow-up: a server-attested country passed in, or those
  functions revoked from `authenticated` behind a server-only wrapper), a model with a country list must never be on sale.
- **Why a CHECK, and why in the database.** `availability` is not in the registry file: the database owns it, and a platform admin
  may change it (0035's column grant). A validator rule alone could not stop that, so the file rule (`modules/model_registry.py`:
  `blocked_countries` needs a `terms_gate`, which 0035's `terms_before_sale` already keeps off sale) is doubled here. A CHECK, like
  0035's `verified_before_sale` and `terms_before_sale`, binds every path: the admin's update, the service role, the SQL editor, a later
  function. A sync that gives an on-sale model a country list is refused whole (23514). `hidden` and `disabled` stay allowed, so the
  operator preview (0139) keeps working.
- **Before applying.** The file refuses, naming them, if a model on sale already carries a list (none does: the only one,
  `grounded-image-1.0`, is hidden). End state: the CHECK exists once and is validated. Apply as ONE transaction.
- **Undo.** `docs/sql/rollback_0142_country_block_before_sale.sql` drops the CHECK. Run it only once the database refuses by country.
- **Numbering.** 0142: main ends at 0139; on open branches 0140 is `claude/meta-probe-no-tools` (#701), 0141 is #699 (made for kids)
  and `claude/youtube-one-org` (to be renumbered), 0143 is `claude/payments-dodo`. It touches no object of theirs. The numbering tests
  of 0127, 0131 and 0133 list it as reviewed.
- **Tests.** `tests/test_country_block_migration.py` (the one CHECK, the guards, the rollback), `tests/security/test_sec_country_block.py`
  (the platform admin, the service role and the owner refused beta and ga for a verified, priced, ungated model with a list; the same
  model goes on sale without one; a sync refused whole; hidden, disabled, `[]` and null allowed; the pre-check; replay; rollback and
  re-apply), `tests/test_geoip_build.py` (the file rule).

## The probe log names a refused vendor tool (0143)

0143 (`0143_probe_error_vendor_tool.sql`) is **live on apply**: it replaces ONE check constraint, `model_probe_runs_error_code_check` (0035),
with the same rule plus one word, `vendor_tool_unsupported`. No table, column, row, function or grant changes.

- **Why.** The first probe of `grounded-image-1.0` (run 43286239903, 2026-11-12) was answered HTTP 400 "Unsupported tool type:
  'image_generation'" with `param: "tools"`. The adapter now raises a typed code for that answer (`E_VENDOR_TOOL_UNSUPPORTED` in
  `modules/capabilities/base.py` `ERROR_CODES`), and `record_model_probe` inserts the code as given: without 0143 such a probe could not be
  recorded at all. Job rows (0036) already take any `^[a-z0-9_]{1,64}$` word; the Studio shows it as "These settings were not accepted".
- **Safe to apply.** The new rule accepts every row the old one did. Apply as ONE transaction (`set local lock_timeout`); the last block
  compares the whole constraint, as Postgres prints it back, to the expected rule (checked on a PostgreSQL 16 server: apply, re-apply,
  rollback, re-apply, and a tampered copy that stops).
- **Undo.** `docs/sql/rollback_0143_probe_error_vendor_tool.sql` (owner-applied): refuses while the log holds a `vendor_tool_unsupported`
  row, then puts 0035's words back and checks the printed rule the same way.
- **Numbering.** 0143, after 0142. It was written as 0140, but 0142 merged and was applied to the live database first. The
  Supabase integration applies a merged migration only if its number is above the last one applied, so 0140 would never run;
  0143 is the next free number. It names nothing of 0139's or 0142's. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Tests.** `tests/test_probe_error_vendor_tool_migration.py` (the newest check lists exactly `ERROR_CODES` and `timeout`; nothing else
  changes; the rollback).

## YouTube's "made for kids" declaration (0145)

0145 (`0145_made_for_kids.sql`, `modules/made_for_kids.py`) is **live on apply**. Every upload used to send
`status.selfDeclaredMadeForKids: false`, while the product offers a Kids story format, kids looks and kids channels: a children's video
declared "not made for kids" breaks YouTube's policy and COPPA. The pipeline now decides the declaration per run (the run's own
`made_for_kids`, a series whose format names kids, a channel DNA look of the Style Library that is made for children only (an explicit list, not the `kids` browsing tag), or the channel's
`agent_config.made_for_kids`, which needs no migration); this file gives that decision a record and a person a way to change it.

- **Adds** seven nullable columns on `videos`: `made_for_kids`, `kids_content` (the pipeline's), `made_for_kids_off_by` and
  `made_for_kids_off_at` (who confirmed "not made for kids" for kids content, and when), with `videos_made_for_kids_confirmed_check`:
  kids content is declared not for kids only with a confirmation, and a confirmation exists only for that, for every writer.
- **The audience is a person's answer** (the owner's decision on PR #699). `made_for_kids_answered_by` / `_at` record who answered
  "is this video made for kids?" on the review page, and when; the pipeline's detection is shown there as a hint only, never as a
  chosen answer. `approve_video_publish` (0116's body plus one block) refuses `audience_unanswered` until a person has answered, so
  nothing is approved, or queued to go public, on the detection alone. The private upload still carries the detection (the field is
  set at insert); the publish-when-approved write sends the answer, correcting YouTube when the two differ, and refuses a video with
  no answer. A run with auto publish on uploads private until then (`made_for_kids.privacy_until_answered`, and the publish gate's
  `audience_unanswered` block as the backstop); such an upload is recorded PENDING, not "approved with nobody behind it", so
  the review panel offers Approve. The answer is bound to one cut: `made_for_kids_answered_cut_sha256`, which
  `set_video_made_for_kids(video, value, confirm_off, cut)` takes (it refuses `cut_changed` for a cut the row no longer
  holds), and approval and the worker count an answer only for the cut they act on. Every writer of a new cut clears it
  (`video_review.record`, `held_video.record_held` and `promote`).
- **Adds** `set_video_made_for_kids(p_video_id, p_made_for_kids, p_confirm_off)` (signed-in users only; the approver's rule of 0112;
  rate limited; refuses `already_public`, `approval_live`, `confirm_required`; audited as `video.made_for_kids`).
- **Replaces** `render_job_params_valid` (0122's body plus `made_for_kids`, true only, never on a repair), `audit_action_allowed`
  (0117's plus `video.made_for_kids`), `approve_video_publish` (0116's plus the answer check) and the `render_jobs_insert` policy
  (0076's plus the key), each its predecessor plus marked lines.
- **Where the declaration goes.** The pipeline's upload and its Short (`modules/youtube_uploader.py`), a cross-post to another channel
  (`modules/social_publish.py`, refused as `made_for_kids_unconfirmed`), and the publish-when-approved write (`modules/visibility_publish.py`,
  which sends the recorded value instead of the one read back). The publish gate blocks `made_for_kids_unconfirmed` on every channel,
  including one that turned the gate off. Instagram and TikTok have no such field in the APIs this repo uses, and are unchanged.
- **Drift guard.** Refuses (changes nothing) if a replaced body is neither its predecessor's nor 0145's, or if
  `set_video_made_for_kids` exists with another body; the last block asserts every body by md5, the grants, the columns, the check, the
  policy and the validator's answers.
- **Apply as ONE transaction.** `set local lock_timeout = '5s'`.
- **Undo together with the code.** The rollback must ship with the revert of this PR's code, not alone: the worker's
  `declared_for_kids` refuses a video that has the 0145 columns and no answer for its cut, and with the rollback applied
  nothing can write an answer any more, so every publish-when-approved request would be refused (and the review panel would
  offer a question it cannot save). Revert the code first or in the same deploy.
- **Undo.** `docs/sql/rollback_0145_made_for_kids.sql` (owner-applied): refuses a body that is not 0145's and a queued or running job that
  carries `made_for_kids`; restores the three predecessors byte for byte and drops the function. It keeps the columns and their check:
  the record of who confirmed what is not erased.
- **Tests.** `tests/test_made_for_kids_migration.py` (the file, pinned), `tests/test_made_for_kids.py` (every upload body) and
  `tests/security/test_sec_made_for_kids.py` (the lab). 0145 sits on 0122's and 0117's bodies, so the lab's `take_off_0121`,
  `take_off_0122` and `take_off_0127` take it off first and their `put_back_*` put it back (`tests/security/sec_db.py`).
- **Numbering.** 0145: merged migrations apply to live in ascending order and main ends at 0143 (#701, after #695's
  0142); 0146 is the Dodo payments branch's. None of them names anything of this file's. The numbering tests of 0127, 0131 and 0133 list
  it as reviewed.

## Dodo Payments next to Paddle (0146)

0146 (`0146_dodo_payments.sql`, `docs/DODO_SETUP.md`) lets the payment tables and the two subscription functions carry a second
provider, Dodo Payments (owner decision 2026-11-12, after Paddle declined the account). It is **live on apply and changes nothing for
Paddle**: no row is written, the Paddle webhook calls the same two functions with the same arguments and gets the same answers, and no
customer reaches Dodo until the Command Center's `PAYMENTS_PROVIDER` is `dodo` and the `dodo-webhook` Edge Function is deployed.

- **What changes.** `payment_events_provider_check` and `subscriptions_provider_check` admit `'dodo'`; the subscription id, customer id
  and price id checks become per provider — a Paddle row must match exactly 0034's patterns, a Dodo row `sub_` / `cus_` / `pdt_` plus
  3-64 ASCII letters and digits (Dodo's documented examples are mixed case). `price_id` holds the Dodo product id.
- **One body per function.** `upsert_subscription_for(provider, ...)` and `grant_subscription_credits_for(provider, ...)` are 0034's
  bodies plus four hunks (the provider checked, the row looked up and inserted under it, the advisory lock keyed
  `subscription:dodo:<id>` for Dodo and unchanged for Paddle). 0034's `upsert_subscription` and `grant_subscription_credits` become one
  line each that calls the twin with `'paddle'`; signatures, defaults, grants (service role only), SECURITY DEFINER and the pinned
  search_path stay. `add_purchased_credits`, `refund_purchased_credits` and `record_payment_event` are not replaced (their hashes are
  asserted before applying): the Dodo webhook uses them as they are, with the Dodo payment id as the purchase's external id and
  `dodo_refund:<id>` / `dodo_dispute:<id>` as the refund id.
- **Checkout nonces (security review of #702).** `dodo_checkout_nonces` (RLS on, no API role privilege) holds one row per Dodo
  checkout the Command Center opened. `dodo_issue_checkout_nonce(org, item)` (authenticated; owner/admin of the organization; 24 hours,
  at most 50 a day per organization) gives the nonce the server signs into the session's metadata; `dodo_consume_checkout_nonce(...)`
  (service role) lets the webhook spend it once, for one pack payment or one new subscription (`ok` | `unknown` | `expired` |
  `consumed` | `mismatch`; the same payment or subscription again is `ok`). md5: issue `ddfe1dc46a18fe7df7823eb09ffbe88f`, consume
  `1b79c8eac0f085985ca8cc8544f72def`.
- **Drift guard and end state.** Before: `upsert_subscription` `60ee6ad3764dbcf6762b178f8240d5a9`, `grant_subscription_credits`
  `7947d46697f1c35d12274ffbe22709ac` (0034), or 0146's own on a replay. After: `upsert_subscription` `09185a96a8fb02f0c2641095d51461cc`,
  `grant_subscription_credits` `fd0c1c169a4d3b2d05c6d826c6fe10ff`, `upsert_subscription_for` `9f9b399ce3ca3421d1ccb32c4075d6ea`,
  `grant_subscription_credits_for` `5424905376fab9ff1b4c229c5dc0c0ce`. The last block asserts bodies, grants, SECURITY DEFINER, the
  pinned search_path and the five check definitions (md5 `0bd392d5168a2de8fb871e400200e7cc`). Apply as ONE transaction.
- **Number.** 0146: merged migrations apply to live in ascending order; live is at 0145 (#699's made_for_kids, 2026-11-13).
  0146 names nothing of 0143's or 0145's. Needs 0021 and 0034. (First written as 0142, then 0143, then 0144, on this
  branch.)
- **Not covered yet.** The margin report (0063) and the operator's Customers page (0138) count paid amounts from Paddle rows only; a
  Dodo payment shows there as not knowable / not counted until a follow-up migration (`docs/DODO_SETUP.md`, "Before you switch").
- **Undo.** `docs/sql/rollback_0146_dodo_payments.sql` (owner-applied): refuses while any `payment_events` or `subscriptions` row names
  `dodo` or a checkout nonce has been spent, or a function is not 0146's body; puts 0034's two bodies back byte for byte, drops the twins, restores 0021's and 0034's checks
  and asserts the end state. Turning Dodo off does not need it (`PAYMENTS_PROVIDER` back to `paddle`).
- **Tests.** `tests/test_dodo_payments_migration.py` (the hunks, the pins, the wrappers, the rollback), `tests/security/test_sec_dodo_payments.py`
  (a real PostgreSQL: grants, the Dodo money path through the shared ledger functions, the Paddle path identical with and without 0146,
  the checks, the drift guard, the rollback and the re-apply), `command-center/tests/dodo-webhook.test.ts` (the webhook).

## Connecting an AI app on every plan; one rate unit per tool call; vendor registrations; spend-limit remedies (0147)

0147 (`0147_mcp_free_tier.sql`, `docs/MCP.md`) is **live on apply**. Owner decision 2026-11-13: "Connect an app" (MCP over OAuth,
0093) is open on every plan, Free included, and limited only by site credits; the API-key door (prepaid USD balance, activation) is
unchanged.

- **The plan gate goes.** `mcp` (0034, enforced by 0093) was read by exactly seven functions, all 0093's: `oauth_ctx` (every call),
  `oauth_begin_authorization` (Free got no request row), `oauth_decide_authorization`, `oauth_exchange_code`, `oauth_refresh`
  (`subscription_required`), `oauth_check` (`entitled`) and `oauth_my_grants` (`paused_plan`); nothing else reads it. Each is 0093's
  body minus that check (`entitled` stays `true` in the answers, `status` stays `active`, for the shapes). The key goes back to
  `planned` (checked nowhere, never advertised), true for every plan and by default, so the pricing matrix and the Usage page stop
  saying "Free: no". Taking the check out, rather than setting Free's row to true, is deliberate: the rule is about the door, and a
  per-plan row would let a new plan, the default plan a lapsed subscription falls to, or one UPDATE close it again.
- **What still limits a connection.** `reserve_credits` inside 0094's `oauth_create_video` (`insufficient_credits` before anything is
  held; welcome, pack and plan credits all count, under the workspace's own "use extra credits" switch), the per-connection monthly
  limit, videos at once by plan, 120 requests a minute, scopes, revocation, the workspace membership check. A pack or a plan makes
  the same connection work on its next call; a connection 0093 had paused works again with no reconnect.
- **One rate unit per tool call** (#707). `oauth_check_credits (grant_id, request_id, created_at)`, primary key (grant, request id),
  RLS on, no API role privilege (service_role included). `oauth_check` puts one credit (`oauth_check_credit_put`) only after it counted
  and let the request through, for the route's id shape `^req_[A-Za-z0-9]{24}$`, `on conflict do nothing`, pruning that grant's
  credits older than 2 minutes. `oauth_ctx` takes it (`oauth_check_credit_take`, one `DELETE ... RETURNING`, younger than a minute)
  and then READS the minute's count (keeping `v_used > v_rpm`) instead of taking a second unit; otherwise it counts as before. Every
  check still costs one unit and frees at most one later call. The foreign key to `oauth_grants` is deferrable only so the end-state
  block can exercise the helpers on a made-up grant inside a block it rolls back (a cascade is never deferred).
- **Vendor registrations.** Claude registers a new client on every fresh connection from Anthropic's shared servers, and ChatGPT once
  per MCP server connection, so 0093's 10 registrations per address an hour throttled the 11th person. A registration whose every
  redirect URI is a vendor's own callback (`claude.ai/api/mcp/auth_callback`, `chatgpt.com/connector_platform_oauth_redirect`,
  `chatgpt.com/connector/oauth/<id>`) is its own class: `oauth_clients.vendor` (generated by `oauth_vendor_callbacks_only`), 300 an
  address an hour, 2 000 an hour in total, a 60 000-row cap. The ordinary class keeps 0093's 10 / 300 / 20 000 over ordinary rows only.
  A vendor-class code can only ever go to the vendor's callback, so the class gains an attacker nothing but rows, and 2 000 an hour
  times the collector's 24 hours (48 000) stays under its cap.
- **Spend-limit remedies** (#707 bug 9). `api_create_video` and `api_request_download` are 0042's bodies with the
  `monthly_limit_reached` and `key_limit_reached` sentences naming where the limit is raised (Developer console: Developers → Usage
  and billing → Monthly spend limit; Developers → API keys → Set limit on this key). Codes, details and every other line are 0042's.
- **Drift guard and end state.** Each of the eleven replaced functions must hold its 0093 / 0042 body or 0147's (md5s in the file).
  The end-state block asserts bodies, SECURITY DEFINER, the pinned search_path, grants, the table's RLS and privileges, the retired
  entitlement and the registration class, and exercises the credit: the first call of a checked request is free, a second call with
  the same request id is counted, another id shape earns nothing, a credit older than a minute is not taken. Apply as ONE transaction.
- **Number.** 0147: live is at 0146; 0148 is reserved by another branch. Names nothing of 0143's, 0145's or 0146's.
- **Replay.** `create or replace`, `if not exists`, revoke then grant: a replay changes nothing. Re-running 0093 after 0147 puts 0093's
  bodies and its `enforced` back (Free pauses again): re-apply 0147 after it.
- **Undo.** `docs/sql/rollback_0147_mcp_free_tier.sql` (owner-applied): refuses unless every function is 0147's body, puts 0093's and
  0042's bodies back byte for byte, drops the credits, the helpers and `oauth_clients.vendor`, and restores the entitlement (enforced,
  Free false). After it, Free connections are paused again and a vendor's server is throttled at 10 an hour again.
- **Tests.** `tests/test_mcp_free_tier_migration.py` (the hunks, the md5 pins, the grants, the rollback),
  `tests/security/test_sec_mcp_free_tier.py` (a real PostgreSQL: Free approves and spends welcome, pack and plan credits, the limits
  that stay, the rate credit under forgery, refusal and a race, the 120-a-minute boundary, vendor and ordinary registration budgets
  and caps, the spend-limit sentences, rollback and re-apply, the drift guard), `tests/security/test_sec_mcp_oauth.py` (0093's
  attacks, now against the 0147 rule), `command-center/tests/mcp-assistant-session.test.ts`.
