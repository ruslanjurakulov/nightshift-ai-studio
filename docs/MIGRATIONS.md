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
  preview and a stored, passing gate verdict (`gate_blocked` / `gate_unknown` / `not_uploaded` / `no_preview` / `cut_unknown` / `rejected`),
  and the acknowledgement `{"rights_and_labels": true}` must be given. It then sets `review_state = 'approved'` with who/when/until (24 hours),
  writes one consumed `review_intents` row and one `video.approve` audit row, and closes the stuck `approve` intents of the dead button as
  `superseded_by_approval`. The same call again while the approval is valid returns `{ok, already: true}` and writes nothing.
- **`video_approve_access(video_id)`** (signed-in) answers `ok | not_admin | not_member | not_found` for the caller and the video; the RPC maps it and the panel asks it to decide whether to offer the key.
- **`video_publish_refusal(video_id, cut_sha256)`** (service role only) is the rule a Phase 1b worker applies before it acts on an approval
  (eligibility, `already_public`, `not_approved`, `cut_changed`, `approval_expired`). Nothing calls it yet. `video_approve_refusal` is its
  internal eligibility half (no API role).
- **A browser can no longer insert an `approve` intent** (`review_intents_insert` is 0033's policy plus `action <> 'approve'`; the other
  actions are as they were).
- **`finish_scene_regeneration`** is 0085's body with one statement extended: the approval's columns are cleared with its state.
  **`audit_action_allowed`** is 0110's list plus `video.approve`.
- **What it does not change:** `publish_request_refusal` (0029). The cross-post rail still reads `review_state = 'approved'`; that is now
  reachable on a channel with auto publish off. An approval stays `approved` after its 24 hours (the panel shows it as expired and
  `video_publish_refusal` says `approval_expired`); it does not close the cross-post rail.
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
