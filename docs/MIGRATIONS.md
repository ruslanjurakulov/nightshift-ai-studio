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
  written, so nothing goes on sale. A model priced by variant or with no stated cost stays `unpriced` (by resolution: since 0149, below,
  the quoted resolution's figure; by quality: since 0153, the quoted tier's figure). The quote carries `"preview": true`.
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
  `chatgpt.com/connector/oauth/<id>`, `grok.com/connectors-oauth-exchange-code/`, `oauth-redirect.googleusercontent.com/r/<segment>`
  and `/a/<segment>`; Google's `-sandbox` / `-test` hosts stay ordinary) is its own class: `oauth_clients.vendor` (generated by `oauth_vendor_callbacks_only`), 300 an
  address an hour, 2 000 an hour in total, a 60 000-row cap. The ordinary class keeps 0093's 10 / 300 / 20 000 over ordinary rows only.
  A vendor-class code can only ever go to the vendor's callback, so the class gains an attacker nothing but rows.
- **Rows stay bounded now that Free can approve** (review of #713). 0093's collector never took a client that had a grant and kept a
  revoked grant 30 days, and the 20-connection cap counts live grants only, so register → Allow → redeem → revoke kept a registration
  alive a month per cycle; one Free account could fill a class's cap (vendor 60 000 in ~30 h, ordinary 20 000 in ~67 h) and close
  registration for everyone. Now `oauth_gc` (0093's body plus one hunk) also deletes a client whose every grant ended (revoked or past
  its absolute expiry) more than 24 hours ago, with those grants (not while someone has its consent screen open, and not within a
  day of its last authorization, so a vendor reusing one client id never turns a person's Allow into `expired`), and `oauth_decide_authorization` refuses
  `too_many_connections_today` after 50 approvals per person or 200 per workspace in a rolling day, revoked ones included (a
  per-workspace advisory lock keeps the counts exact). A class then holds the last 24 hours of registrations (48 000 vendor, 7 200
  ordinary, under the caps) plus at most 40 rows per account (20 live, 20 ended less than a day ago): a flood at the ceiling cannot
  fill it. Two indexes on `oauth_grants` (client; org, created) serve the collector and the counts. The consent screen names both
  refusals (`too_many_connections` and `too_many_connections_today`) in en/ru/uz. Cost: an app whose connection ended more than a
  day ago is an unknown client and is added again (Claude registers anew on every connection anyway).
- **One fixed minute can see ~240 tool calls.** A check admitted at the end of one minute leaves a credit its call may spend in the
  next; the sustained rate stays 120 a minute and every call that makes a video stays bound by credits and the connection's limit.
- **Spend-limit remedies** (#707 bug 9). `api_create_video` and `api_request_download` are 0042's bodies with the
  `monthly_limit_reached` and `key_limit_reached` sentences naming where the limit is raised (Developer console: Developers → Usage
  and billing → Monthly spend limit; Developers → API keys → Set limit on this key). Codes, details and every other line are 0042's.
- **Drift guard and end state.** Each of the twelve replaced functions (`oauth_gc` included) must hold its 0093 / 0042 body or
  0147's (md5s in the file). The end-state block asserts bodies, SECURITY DEFINER, the pinned search_path, grants, the tables' RLS and
  privileges, the SHAPE of every `if not exists` object (the generated `vendor` expression; `oauth_check_credits` columns, key,
  cascade and check), the daily caps and indexes, the retired entitlement and the registration class, and exercises the credit: the first call of a checked request is free, a second call with
  the same request id is counted, another id shape earns nothing, a credit older than a minute is not taken. Apply as ONE transaction.
- **Number.** 0147: live is at 0146; 0148 is reserved by another branch. Names nothing of 0143's, 0145's or 0146's.
- **Replay.** `create or replace`, `if not exists`, revoke then grant: a replay changes nothing. Re-running 0093 after 0147 puts 0093's
  bodies and its `enforced` back (Free pauses again): re-apply 0147 after it.
- **Undo.** `docs/sql/rollback_0147_mcp_free_tier.sql` (owner-applied): refuses unless every function is 0147's body, puts 0093's and
  0042's bodies back byte for byte (0093's `oauth_gc` too), drops the credits, the helpers, `oauth_clients.vendor` and the two indexes,
  and restores the entitlement: the key as 0093 left it, and each plan's value as 0147 found it, from
  `oauth_mcp_entitlement_before_0147` (0147 saved it before setting every plan true; the rollback restores it and drops the table).
  After it, Free connections are paused again and a vendor's server is throttled at 10 an hour again. Registration can be closed
  for a while after it: 0093 counts every row against one 300-an-hour / 20 000-row budget (the file's header has the read-only query).
- **Tests.** `tests/test_mcp_free_tier_migration.py` (the hunks, the md5 pins, the grants, the rollback),
  `tests/security/test_sec_mcp_free_tier.py` (a real PostgreSQL: Free approves and spends welcome, pack and plan credits, the limits
  that stay, the rate credit under forgery, refusal and a race, the 120-a-minute boundary, vendor and ordinary registration budgets
  and caps, connect-and-revoke past the daily cap and the collection a day later, the workspace cap, a race at the cap, each plan's
  value through rollback, the spend-limit sentences, rollback and re-apply, the drift guard), `tests/security/test_sec_mcp_oauth.py` (0093's
  attacks, now against the 0147 rule), `command-center/tests/mcp-assistant-session.test.ts`.

## Operator preview priced by resolution (0149)

0149 (`0149_preview_price_by_resolution.sql`) is **live on apply** and writes no row. It replaces ONE function, `creative_price`, on 0139's
body plus two hunks, and changes an answer only for 0139's preview (the platform operator, in the credits-exempt organization, a hidden
model marked `operator_preview`) of a model priced by resolution.

- **Why.** 0139 quotes a preview with no `credit_prices` row at the vendor's cost only when the registry states one flat figure. Every
  MiniMax H3 video entry is priced by resolution (`pricing.variants.by = "resolution"`), so every preview quote of them was `unpriced`:
  a model listed as available whose every generation was refused.
- **The rate.** No variants: `provider_usd_per_unit`, as in 0139. By resolution: `variants.prices[<resolution>]`, where the resolution is
  the one 0070's video settings already settle on for every quote (the request's, else the pinned `default_resolution` only when the
  request names none). It is the one the quote names, the job carries and the worker sends. A listed resolution without its own figure
  (or with a figure that is not a number, 0, or over 100) is `unpriced`; it is never mapped to another resolution or to
  `provider_usd_per_unit`. Any other `variants.by` stays `unpriced`. Same conversion as 0139 (x 100, no margin, `job_minimum` floor);
  a `credit_prices` row for the variant still wins; who may preview is 0139's rule, not replaced.
- **Known gap, not changed here.** `creative_params_problem` (0126's body) accepts a named resolution only from 480p 540p 720p 1080p 1440p
  2160p. A request that names `768p` or `2k` is refused `invalid_params` before the model is read. 768p is reached as the pinned default
  (the Studio sends no resolution); H3's 2k is not reachable. `tests/security/test_sec_preview_price_by_resolution.py` pinned this as a
  strict xfail. Closed by 0156 (below).
- **Drift guard and end state.** The live `creative_price` must be 0139's body (`ae28b700503542701ee0ac63a67df36e`) or 0149's
  (`728241a09e56f65e19efc460afea7355`). The last block asserts the body, no API role grant, the pinned search_path and the three guards.
  Apply as ONE transaction.
- **Order.** 0149 sits on 0139's `creative_price` and refuses to apply without 0139. 0139's replay and rollback refuse 0149's body: run
  `docs/sql/rollback_0149_preview_price_by_resolution.sql` first (it puts 0139's body back byte for byte). The lab takes 0149 off before
  0139 (`sec_db.take_off_0139` calls `take_off_0149`; `sec_db.ON_0139`, and `ON_0125` now lists both). The numbering tests of 0127, 0131
  and 0133 list it as reviewed.
- **Tests.** `tests/test_preview_price_by_resolution_migration.py` (the hunks, the hashes, the rollback, the lab chain, the registry
  entries it turns on), `tests/security/test_sec_preview_price_by_resolution.py` (480p and 768p quote their own costs; no resolution is
  the pinned default and the job carries it; an unlisted resolution is `invalid_params`, a listed unpriced one `unpriced`; everyone 0139
  refuses is still refused; a model on sale is never quoted at cost; a variant row wins; other `variants.by` stay `unpriced`; with 0149
  rolled back only these answers change; order, drift guard and rollback on a scratch database).

## The Studio's progress seed from a probe (0151)

0151 (`0151_model_probe_seconds.sql`) is **live on apply and read-only**: it adds ONE function, `model_probe_seconds(p_models text[])`,
and nothing else. A running generation's "~N%" in the Studio came only from the organization's own finished jobs on the same model (at
least 3), so a just-added model showed seconds for its first three jobs everywhere. The function hands the Studio the newest
successful probe of each model asked for, one row per capability probed (`model_probe_runs`, 0035): its wall time in seconds, the probe block's clip
length (`spec.probe.duration_s`, only for the same capability) and when it ran, plus `failed_after` when a probe of the same capability
failed since. The Studio uses it as the expected time until the organization has 3 finished jobs of its own, and the pill says
"test run" (rule 5).

- **What the number is.** `tools/probe_models.py` times submit → poll → download, so the seconds INCLUDE the download and the poll
  interval (and, for a voice tool, the short speech clip the probe makes first). Only a probe of the adapter and vendor model the
  registry calls today counts.
- **Who sees what.** SECURITY DEFINER, pinned search_path; execute to `authenticated` only (not anon, not the service role). Probes are
  platform-wide test calls: no organization's data. A customer gets rows only for models on sale and not switched off by the owner
  (beta/ga, verified and `model_is_available()`: exactly what 0124's `model_registry_select` shows them); a platform admin for any model
  (the 0139 preview). Never error text, bytes, prober, adapter or vendor model. NEW for customers, for models on sale: the test run's
  seconds, the probe's clip length, when it ran, and one boolean (`failed_after`) saying a probe of that capability failed since.
- **Input.** At most 50 ids of the registry's id shape, no null, one dimension; otherwise `22023 invalid models`. The Studio asks for
  at most 4, and only for models with fewer than 3 finished jobs here.
- **Without it.** The durations route reads a missing function (or any error) as "no seed": the pill counts seconds, as before.
- **md5.** `model_probe_seconds` `265e5c68919c76546b60de9dd0972493` (drift guard, end state, rollback).
- **Number.** 0151: 0147 and 0149 are merged on main and live, 0148 and 0150 are reserved. Needs 0018, 0035 and 0124; names nothing
  of 0147's or 0149's.
  The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0151_model_probe_seconds.sql` (owner-applied): refuses a body that is not 0151's, drops the function.
- **Tests.** `tests/test_model_probe_seconds_migration.py` (the text), `tests/security/test_sec_model_probe_seconds.py` (a real
  PostgreSQL: grants, visibility, which probe, the clip length, the bounds, replay and rollback), `command-center/tests/studio-progress.test.ts`,
  `durations-route.test.ts` and `studio-progress-ui.test.tsx` (the seed's use in the pill).

## The probe log keeps the vendor's own bill for a probe (0152)

0152 (`0152_probe_vendor_credits.sql`) is **live on apply** and additive: one nullable column, `model_probe_runs.vendor_credits`
(no default, so no row is rewritten; NULL or 0 to 1,000,000, NaN and Infinity refused), and one NEW overload of `record_model_probe`
with an eleventh argument, `p_vendor_credits numeric`. 0035's ten-argument form, every grant, policy, trigger and row are untouched.

- **Why.** Runway reports `cost.credits` on a finished task; the first probes (2026-11-13) cost 60 (gen4.5, 5 s) and 25 (gen4_turbo,
  5 s) credits, and the figure lived only in the workflow log. The Billing page now counts probes per provider
  (`command-center/lib/billing.ts` `providerLedger`): a stored figure is the vendor's bill; without one, the probe is priced from the
  registry and labelled an estimate.
- **No default on the new argument, on purpose.** With a default, a ten-argument call would match both overloads and Postgres would
  refuse it as ambiguous, breaking the probe tool of the previous release and the security lab. A ten-argument call reaches 0035's
  function; an eleven-argument call reaches 0152's, whose body is 0035's word for word plus the column (the static test compares them).
- **The writer before 0152 is applied.** `tools/probe_models.py` sends `p_vendor_credits` only when the vendor reported a figure (0 to
  1,000,000). Against a database without 0152, or a stale PostgREST schema cache, that call answers **404** (no function with these
  argument names) and nothing was written; the tool then records the same probe once through the ten-argument form and logs that the
  figure was not stored ("apply migration 0152"). This is the harmless-fallback case above: the first call wrote no row, so the
  append-only log cannot get a duplicate. Any other refusal is raised, not retried. The Billing page reads `vendor_credits` and, on
  42703 (column not there), reads the probes again without it.
- **Who may call it.** The service role only (EXECUTE revoked from public, anon and authenticated), SECURITY DEFINER with a pinned
  search_path, like 0035's. The last block asserts the column, the grants, the definer and search_path, and that 0035's form still
  exists. Apply as ONE transaction (`set local lock_timeout`).
- **Undo.** `docs/sql/rollback_0152_probe_vendor_credits.sql` (owner-applied): drops the eleven-argument overload, the check and the
  column (the figures recorded since 0152 are lost; the probe rows stay). Deploy a probe tool that no longer sends the figure first.
- **Numbering.** 0152; 0148, 0150 and 0151 are reserved by other work. The numbering tests of 0127, 0131 and 0133 list it as reviewed:
  it names nothing of theirs.
- **Tests.** `tests/test_probe_vendor_credits_migration.py` (the column and rule, no default, the body equals 0035's plus the column,
  service-only grants, the rollback; the writer: figure sent only when reported, the 404 fallback writes one row, other refusals raise),
  `tests/security/test_sec_probe_vendor_credits.py` (service-only execute, the ten-argument call still works, verification unchanged,
  out-of-range figures refused, append-only, a customer reads no probe row).

## Operator preview priced by quality (0153)

0153 (`0153_preview_price_by_quality.sql`) is **live on apply** and writes no row. It replaces ONE function, `creative_price`, on 0149's
body plus two hunks, and changes an answer only for 0139's preview (the platform operator, in the credits-exempt organization, a hidden
model marked `operator_preview`) of a model priced by quality.

- **Why.** 0139 quotes a preview with no `credit_prices` row at the vendor's cost from one flat figure, and 0149 added the quoted
  resolution's figure. An image model priced by quality tier (`pricing.variants.by = "quality"`: the OpenAI GPT Image entries) still had
  no figure a preview could read, so every preview quote of it was `unpriced`.
- **The rate.** By quality: `variants.prices[<tier>]`, where the tier is the one 0060's quality settings already settle on for `t2i` and
  `edit` (the request's `quality`, else `medium` only when the request names none). It is the one the quote names, the job carries and the
  worker sends. A tier the model does not list is `invalid_params` (unchanged), and so is no tier on a model that does not list `medium`.
  A listed tier without its own figure (null, not a number, 0, or over 100) is `unpriced`; it is never mapped to another tier or to
  `provider_usd_per_unit`. A capability that settles no tier (video) stays `unpriced`. 0149's two sources are unchanged. Same conversion
  (x 100, no margin, `job_minimum` floor); a `credit_prices` row for the tier still wins; who may preview is 0139's rule, not replaced.
- **No registry entry is turned on by it yet.** The owner asked to preview `openai-gpt-image-2.5-flare`, `openai-gpt-image-2.5-sunburst`,
  `ideogram-3` and `ideogram-4`, but none of them states a figure this rate can read: the OpenAI tiers are all `null` (OpenAI bills GPT
  Image 2.5 by token, and its model page says the GPT Image 2 calculator does not estimate GPT-Image-2.5 token use, so there is no
  per-image figure to copy), and the Ideogram entries have no figure (Ideogram's API price table at https://ideogram.ai/api-pricing is
  drawn in the browser by a script that a plain fetch is refused, so it could not be read, 2026-11-13). Marking any of them would be a
  model shown as available whose every generation is refused, so none is marked and none is given a guessed figure.
  `tests/test_preview_price_by_quality_migration.py` pins the preview set and refuses a marked entry whose figures do not resolve.
- **Drift guard and end state.** The live `creative_price` must be 0149's body (`728241a09e56f65e19efc460afea7355`) or 0153's
  (`28130a014027e6ad0b7876a78d69a396`); 0139's body is refused (0149 must come first). The last block asserts the body, no API role
  grant, the pinned search_path and the three guards. Apply as ONE transaction.
- **Order.** 0153 sits on 0149's `creative_price` and refuses to apply without it. 0149's replay and rollback refuse 0153's body: run
  `docs/sql/rollback_0153_preview_price_by_quality.sql` first (it puts 0149's body back byte for byte). The lab takes 0153 off before
  0149 (`sec_db.take_off_0149` calls `take_off_0153`; `take_off_0139` now also recognises 0153's body; `sec_db.ON_0149`, and `ON_0139`
  and `ON_0125` list it last). Numbering: 0153; 0148 and 0150 are reserved by other work. The numbering tests of 0127, 0131 and 0133
  list it as reviewed.
- **Tests.** `tests/test_preview_price_by_quality_migration.py` (the hunks, the tier is the quote's own, the hashes, the rollback, the
  lab chain, the preview set), `tests/security/test_sec_preview_price_by_quality.py` (low, medium and high quote their own costs; no
  tier is medium and the job carries it; an unoffered tier is `invalid_params`, an unpriced listed one `unpriced`; everyone 0139 refuses
  is still refused; a model on sale is never quoted at cost; a tier row wins; a video entry "by quality" stays `unpriced`; with 0153
  rolled back only these answers change; the lab chain helpers; order, drift guard and rollback on a scratch database).

## A quote refuses a shape the model does not list (0155)

0155 (`0155_shape_offered_by_model.sql`) is **live on apply** and writes no row. It replaces ONE function, `creative_price`, on 0153's
body plus one hunk, and changes an answer only for a request that names an `aspect_ratio` the model's spec does not list for that
capability: a request the worker already refuses before it calls a vendor.

- **Why.** On 2026-11-13 `ideogram-4` and `ideogram-4.5` t2i jobs with `{"aspect_ratio": "16:9"}` were quoted and created, and the
  worker then failed them (`aspect ratio 16:9 is not offered for t2i by ideogram-4`). `creative_params_problem` only checks that a shape
  looks like `16:9`, and `creative_price` read the model's own list for `expand` (0099) and `video_reframe` (0100) only, so the first
  reader for `t2i`, `t2v`, `edit` and `i2v` was the worker, after the job and its hold (`docs/research/ideogram-shapes-2026-11-13.md`).
- **The rule.** A named `aspect_ratio` must be in `spec.aspect_ratios_by_capability[<capability>]` when that names some, else in
  `spec.aspect_ratios`: exactly the worker's `ModelEntry.aspects_for` (an empty narrowing reads as none). An empty list refuses every
  shape, and so does a spec with no list. Refused `invalid_params`, "`<model>` does not offer the `<shape>` shape for `<capability>`".
  No shape named: unchanged. The router (0075 / 0088) treats a `creative_price` refusal as "not a candidate", so a routed request skips
  a model that cannot make the shape instead of being routed to it and failed.
- **Before it helps.** The list is the one `tools/probe_models.py --sync` copied into `model_registry.spec` from
  `schemas/model_registry.json`. Run a sync after merging (the Probe models workflow does one): until then the database reads the lists
  of the last sync (for `ideogram-4` and `ideogram-4.5`, the old empty ones, which already refuse every shape: the same answer the
  worker gave, only earlier).
- **Drift guard and end state.** The live `creative_price` must be 0153's body (`28130a014027e6ad0b7876a78d69a396`) or 0155's
  (`48105e11fbd820b6f103c19b8fd1e693`); 0149's body is refused (0153 must come first). The last block asserts the body, no API role
  grant, the pinned search_path, the three guards and the shape check. Apply as ONE transaction.
- **Order.** 0155 sits on 0153's `creative_price` and refuses to apply without it. 0153's replay and rollback refuse 0155's body: run
  `docs/sql/rollback_0155_shape_offered_by_model.sql` first (it puts 0153's body back byte for byte). The lab takes 0155 off before
  0153 (`sec_db.take_off_0153` calls `take_off_0155`; `take_off_0149` and `take_off_0139` recognise 0155's body; `sec_db.ON_0153`, and
  `ON_0149`, `ON_0139` and `ON_0125` list it last). Numbering: 0155; 0154 is reserved by other work. The numbering tests of 0127, 0131
  and 0133 list it as reviewed.
- **Tests.** `tests/test_shape_offered_by_model_migration.py` (the hunk, the list is the worker's own for every registry entry, the
  hashes, the rollback, the lab chain, every synced row states its list), `tests/security/test_sec_shape_offered_by_model.py` (a listed
  shape is quoted and an unlisted one refused by name; an empty or missing list refuses every shape; a capability narrowing; the
  operator preview held to the same list; a refused shape never becomes a job or a hold; with 0155 rolled back the same job is queued
  and every other answer is 0153's; order, drift guard and rollback on a scratch database).

## A model's own resolution names (0156)

0156 (`0156_named_resolution_params.sql`) is **live on apply** and writes no row. It replaces TWO functions: `creative_params_problem`
on 0126's body plus one hunk, and `creative_price` on 0155's body plus one hunk (0155's shape check is kept as it is).

- **Evidence.** On the live database (2026-11-13) a `t2v` job for `minimax-h3-max` / `minimax-h3` with `{"resolution": "768p"}` was
  refused at quote and create with `invalid_params: resolution must be one of 480p 540p 720p 1080p 1440p 2160p`, while the same job
  without `resolution` was quoted and stored at 768p (the pinned `default_resolution`, 0070).
- **Diagnosis.** `creative_params_problem`'s resolution test was a closed list of six names (0036 to 0126). 0070 added each model's own
  list (`spec.resolutions`, checked in `creative_price`) and 0149 priced the operator preview by the quoted resolution, but neither
  widened the list, so 768p, 2k, 4k and 360p were refused before any model was read (the 0149 "known gap" below, pinned there as a
  strict xfail). The Studio is not involved: it sends no `resolution` for `t2v` / `i2v` (`lib/creative/studio.ts` `buildParams`); the
  creative API routes (they check keys, not values) and the CLI's `--resolution` pass a name through. The worker adapters already
  speak these names.
- **The rule.** A request may name any string of the registry's resolution shape, `^([0-9]{3,4}p|[24]k)$` (the pattern in
  `schemas/model_registry.schema.json`; a test keeps the two equal). Lower case only: `2K` and `768P` stay refused, never read as
  another name. `creative_price` then refuses a name the model does not list (`invalid_params`, 0070, unchanged) and prices a listed one
  by 0070's video settings: on a model priced by resolution with a pinned default, the variant's own unit
  (`model_<id>_<unit>_<resolution>`, its `credit_prices` row, or for the operator preview 0149's `variants.prices[<resolution>]`).
- **The one new refusal.** A name the old list refused is sold **only** at its own variant's price. When the quote was not priced by a
  resolution variant (a flat-priced model; a model priced by resolution that pins no default and so is sold by its base row, as 0070
  sells Veo 3.1, whose 4k costs the vendor more than that row's figure; a capability without resolution variants), the name is refused
  before any rate is read: `unpriced` for `t2v` / `i2v`, `invalid_params` otherwise. Widening what a request may name never widens
  what a base row sells. Every quote that names no resolution or one of the six is answered exactly as under 0155 (the lab compares the
  two on a corpus).
- **What it turns on.** Nothing goes on sale: no price row, no availability. Today a named 768p / 2k reaches MiniMax H3 (and H3 Lite /
  Highspeed / Max at 480p / 768p) in the operator's preview; any other model once the owner sets the variant's `credit_prices` row. A
  resolution picker in the Studio is a separate change.
- **Drift guards and end state.** Live `creative_params_problem` must be 0126's (`6e815ae544cbb23d7f03845465f8ce6a`) or 0156's
  (`25ee9cc62a27ad3a19e71008b04f3f36`); live `creative_price` must be 0155's (`48105e11fbd820b6f103c19b8fd1e693`) or 0156's
  (`a70dba23b303c72f2b9f5dc5acb3b3ec`); 0153's body is refused (0155 first). The last block asserts both bodies, no API role grant, the
  pinned search_path, the volatility, the four guards (0155's shape check included) and the new resolution answers. Apply as ONE transaction.
- **Order.** 0156 sits on 0126's `creative_params_problem` and 0155's `creative_price` and refuses to apply without them. 0126's and
  0155's replays and rollbacks refuse 0156's bodies: run `docs/sql/rollback_0156_named_resolution_params.sql` first (it puts 0126's and
  0155's bodies back byte for byte). The lab takes 0156 off before 0155 (`sec_db.take_off_0155` calls `take_off_0156`; `sec_db.ON_0155`,
  listed in `ON_0153`, `ON_0149`, `ON_0139` and `ON_0125`), and before replaying 0126 (`test_sec_region_edit_run.py`). Numbering: 0156;
  0155 is merged (#728), 0154 is held by an open branch. The numbering tests of 0127, 0131 and 0133 list it as reviewed. An open branch that replaces either function
  and merges first makes this file's guard refuse: rebase the hunks on that body.
- **Tests.** `tests/test_named_resolution_params_migration.py` (the two hunks, the shape equals the schema's and fits every registry
  name, the grandfathered list is 0126's, the hashes, the rollback, the lab chain), `tests/security/test_sec_named_resolution_params.py`
  (768p and 2k quote their own figures and the job carries 2k; a customer is held at a 2k row; no row of its own is `unpriced`; wrong
  case or shape is `invalid_params` before any model is read; an unlisted name is `invalid_params`; a base-row model's 4k and a flat
  model's 768p are `unpriced`, a stray variant row included; a capability without variants refuses a new name; with 0156 rolled back
  only the new names change; order, drift guards, replay and rollback on a scratch database), and
  `tests/security/test_sec_preview_price_by_resolution.py`, whose strict xfail for the named 768p / 2k is now an ordinary test.

## The Credits page's Dodo purchase history (0157)

0157 (`0157_dodo_purchase_history.sql`) is **live on apply** and read-only: ONE new function, `dodo_purchase_history(p_org uuid,
p_payment text default null)`, and nothing else (no table, column, row, index, policy or trigger; nothing replaced). Nothing calls it
until the Command Center sells through Dodo (`PAYMENTS_PROVIDER=dodo`).

- **Why.** The "Add credits" change (typed amounts next to the packs, Ideogram-style) also shows an invoice history: each Dodo payment
  that credited the organization, what it bought, when, the amount Dodo charged (tax included), its refund state, and a link to Dodo's
  own invoice PDF. Everything known about a payment is in `payment_events` (0021), which no API role may read, and the Command Center
  uses the member's session and the anon key only; so an owner or admin gets their organization's rows through this function.
- **What a row says.** `payment_id` (pay_…), `item` (the signed item from the checkout nonce the payment spent, 0146: `pack:<id>` or
  `pack:amount_<cents>`; `plan` for a plan period, read from its `subscription` ledger row; null when neither is known, shown as "—"),
  `credits`, `amount_minor` and `currency` (Dodo's `total_amount`), `paid_at`, `refunded_minor` (processed refunds in the same currency),
  `refund_unsized` (a processed refund with no amount or another currency: "refund recorded"), `chargeback` (a lost or accepted dispute).
  Only `payment.succeeded` rows that are `processed` or `duplicate` for this organization, one per payment (the processed one wins),
  newest first, at most 100. Rejected, ignored and failing payments (paid, not credited) are not listed.
- **Who may call it.** Signed in, and an owner or admin of `p_org` (`is_org_member(p_org, 'admin')`, 0018: the bar for buying and for
  `dodo_issue_checkout_nonce`; a platform owner or admin holds it in every organization). Everyone else, a null organization included,
  gets 42501. `p_payment` must be `^pay_[A-Za-z0-9]{3,64}$` (the webhook's own shape) or 22023; the invoice route uses it to ask "is
  this payment this organization's?" before it calls Dodo. SECURITY DEFINER, stable, `search_path = public, pg_temp`, execute for
  `authenticated` only (not anon, not service_role, not PUBLIC). The last block asserts the body, grants, definer, volatility and
  search_path. Apply as ONE transaction.
- **md5.** `dodo_purchase_history` `83396f8724ca4968b7c56f2297aa0830` (drift guard, end state, rollback).
- **Without it.** The Credits page shows "the purchase history needs migration 0157" in the history panel; the invoice route answers
  503 without calling Dodo. Buying and crediting never read it.
- **Number.** 0157 (first written as 0154): 0155 (#728) and 0156 (#730) are merged before it, and the Supabase integration
  refuses a number below the latest applied one. Needs 0018, 0021, 0034 and 0146; names nothing of 0147's to 0156's. The numbering
  tests of 0127, 0131 and 0133 list it as reviewed, next to 0155 and 0156.
- **Undo.** `docs/sql/rollback_0157_dodo_purchase_history.sql` (owner-applied): refuses a body that is not 0157's, drops the function.
- **Tests.** `tests/test_dodo_purchase_history_migration.py` (the text, the hash, the rollback, the numbering),
  `tests/security/test_sec_dodo_purchase_history.py` (a real PostgreSQL: anon, the service key, a stranger and a plain member refused;
  the owner sees each credited payment once with its signed item, a plan period labelled `plan`, rejected and failing payments left
  out, another organization's payment not answered by id; refunds without an amount or in another currency unsized; a lost dispute a
  chargeback; malformed ids refused; replay, rollback, drift and the 0146 prerequisite), `command-center/tests/add-credits-ui.test.tsx`
  (the page's reading of the rows) and `command-center/tests/dodo-checkout.test.ts` (the invoice route).

## Concept-thumbnail settings are an administrator's (0158)

0158 (`0158_thumbnail_concept_admin_lock.sql`) is **live on apply**. It rewrites no row and widens no grant. It replaces one small
function and adds one trigger.

- **Why.** `agent_config.thumbnail_mode = "concept"` (modules/thumbnail_concept.py, PR #731) makes every run of the channel pay for a
  planner call and one generated image per A/B arm on the worker's provider keys. `agent_config.thumbnail_concept` picks the image
  provider and model, whether invented faces (`allow_faces`) or words from the fact-checked texts (`allow_baked_text`) may appear,
  and the headline style. Before 0158 any editor of the organization could change both keys, like any other agent_config key.
- **What changes.** `channel_admin_controls()` (0086) lists the two keys after its four, so `create_channel()` holds them to an
  administrator, or to a trusted server caller. A second BEFORE INSERT OR UPDATE trigger, `channels_thumbnail_concept_guard`
  (security invoker, browser roles only, execute revoked from everyone), refuses a write that sets, changes or removes either key
  unless the caller administers the channel's organization: 42501, message prefix and hint `thumbnail_concept_lock`. A whole blob
  carried back unchanged, an unrelated edit, the service role and the definer functions pass. `patch_channel_agent_config` (0119)
  already refuses both keys. The 0119 guard body (md5-pinned) is not touched.
- **Drift guard.** The file refuses to run when `channel_admin_controls()` is neither 0086's four keys nor 0158's six. It takes a
  short lock on `public.channels` to create the trigger (`lock_timeout` 5s).
- **Without it.** An editor can switch a channel to paid concept thumbnails. The worker and the credit hold still work: the
  Command Center adds one image per arm (ceiling 4) at the `image_generations` price to a concept channel's run hold, or refuses the
  run with the gap `unpriced_concept_thumbnail` when that price is unset (lib/credits.ts `withConceptThumbnail`).
- **Number.** 0158: 0157 is the highest on main. Needs 0018, 0020 and 0086 (and 0114's `create_channel`). Names nothing of
  0127's, 0131's or 0133's; their numbering tests list it as reviewed.
- **Undo.** `docs/sql/rollback_0158_thumbnail_concept_admin_lock.sql` (owner-applied): drops the trigger and its function and puts
  0086's four-key `channel_admin_controls()` back. A row keeps whatever keys it has.
- **Tests.** `tests/test_thumbnail_concept_lock_migration.py` (the text, the keys equal the worker's, the rollback),
  `tests/security/test_sec_thumbnail_concept_lock.py` (a real PostgreSQL: an editor and a viewer refused on set, change, removal,
  `jsonb_set` and whole-blob replacement; `create_channel` holds both keys; an administrator, the owner and the service role pass;
  an unchanged blob passes; replay, rollback and drift), `tests/security/test_sec_breach_channel_config.py` (the live control
  list) and `command-center/tests/reserveRunCredits.test.ts` (the hold).

## A quote refuses a clip length the model does not list (0159)

0159 (`0159_duration_offered_by_model.sql`) is **live on apply** and writes no row. It replaces ONE function, `creative_price`, on
0156's body plus one hunk (0155's shape check and 0156's named-resolution rule are kept as they are).

- **Evidence.** Read from the code (2026-11-13): `creative_params_problem` (0126, unchanged by 0156) checks only that `duration_s` is a
  whole number from 1 to 60, and `creative_price` checks the model's own list for a shape, a resolution, a quality, a factor, a language,
  a target and a light, but never for a length. The first reader of `spec.durations_s` is the worker's `ModelEntry.problems`
  (`duration <n>s is not offered by <model>`), after the quote, the job and its hold. The Studio offered 5 and 10 seconds to every video
  model (`VIDEO_DURATIONS`): Veo 3.1 makes 4, 6 or 8; LTX 2.5 Pro 6, 8 or 10.
- **The rule.** When the params name a `duration_s`, the model must list it in `spec.durations_s` (exactly the worker's list; `--sync`
  copies it and `sellable_models()` already returns it). An empty list (image and voice models) and a spec with no list refuse every
  length. Refused `invalid_params` with `<model> does not offer a <n>-second clip for <capability>`. No length named: unchanged. The
  router treats the refusal as "not a candidate", so Auto skips a model that cannot make the length.
- **What ships with it.** The Studio builds its shape, length and resolution keys from the picked model's own lists (Auto: the union
  over the models this organization can buy, with a note), so it no longer offers a length the model refuses.
- **Before it helps.** `model_registry.spec` must carry `durations_s` (every sync since 0035 copies it; the schema requires it). The
  file REFUSES to apply while an offered timed model (beta / ga, or an operator preview) states no list, and names the models: run
  Actions -> Probe models with `--sync`, then apply. The last Verify column checks every timed row.
- **Drift guard and end state.** Live `creative_price` must be 0156's (`a70dba23b303c72f2b9f5dc5acb3b3ec`) or 0159's
  (`dafc5edae0000e741ac1b19bd0075790`); 0155's body is refused (0156 first). The last block asserts the body, no API role grant, the
  pinned search_path, the volatility and every guard (0124, 0125, 0139, 0155, 0156, and the new length check). Apply as ONE transaction.
- **Order.** 0156's replay and rollback refuse 0159's body: run `docs/sql/rollback_0159_duration_offered_by_model.sql` first (it puts
  0156's body back byte for byte). The lab takes 0159 off before 0156 (`sec_db.take_off_0156` calls `take_off_0159`; `sec_db.ON_0156`,
  listed in `ON_0155` and so in `ON_0153`, `ON_0149`, `ON_0139` and `ON_0125`). Numbering: 0159; 0157 and 0158 are merged (neither replaces a creative
  function). The numbering tests of 0127, 0131 and 0133 list it as reviewed. An open branch that replaces `creative_price` and merges first
  makes this file's guard refuse: rebase the hunk on that body.
- **Tests.** `tests/test_duration_offered_by_model_migration.py` (the hunk, the list is the worker's, the hashes, the rollback, the lab
  chain, every synced row states its lengths) and `tests/security/test_sec_duration_offered_by_model.py` (a listed length is quoted and
  created, an unlisted one is refused before anything is held for the customer and for the operator's preview, an empty or missing list
  refuses, Auto skips a model that cannot make the length, every other answer is 0156's on a corpus, order, drift guard, replay and
  rollback on a scratch database).

## ChatGPT keeps the client it registered (0161)

0161 (`0161_mcp_chatgpt_client.sql`) is **live on apply** and changes only what the MCP OAuth collector deletes: `oauth_gc` is
0147's body plus one hunk; ONE new internal helper, `oauth_chatgpt_callbacks_only(text[])`; and, so the collector stays cheap,
the stored generated column `oauth_clients.chatgpt` (from that helper, like 0147's `vendor`) with the partial index
`oauth_clients_chatgpt_idx`. No table, row, policy, trigger or grant on anything else.

- **Why.** OpenAI's authentication guide for MCP servers (https://developers.openai.com/plugins/build/auth): ChatGPT runs dynamic
  client registration once per MCP server connection and reuses that client id; "If your authorization server expires, deletes,
  or replaces either credential, users and reviewers may receive an invalid_client error when they connect." 0147's collector
  deleted a client a day after its every connection ended (its own note: "ChatGPT and others are re-added"), so a ChatGPT
  connection that was disconnected, or reached its 90-day cap, and signed in again more than a day later was refused as an
  unknown app until the person re-created the plugin. Claude registers a new client on every connection and is not affected.
- **The rule.** A client whose every redirect URI is one of ChatGPT's own callbacks (`https://chatgpt.com/connector_platform_oauth_redirect`,
  `https://chatgpt.com/connector/oauth/<id>`) is not taken by 0147's branch for 30 days after a person's last (redeemed) connection
  with it ended, for at most 3 such clients per person, the ones that ended most recently. After that 0093's rules take it as
  before (an ended grant goes at 30 days, then a client with none). A Claude client, a mixed registration and a ChatGPT client
  nobody approved still go a day later. A kept client gives nobody a connection: its tokens stay dead and every sign-in shows
  the consent screen.
- **Rows.** The vendor class holds 60 000; registrations at their hourly ceiling hold 48 000 of them for a day, leaving about
  12 000 that must be filled with rows that outlive a day. Live connections dominate: an account holds 20 live plus those ended in
  the last day (about 40 rows, 0147's bound of roughly 300 accounts); 0161 adds at most 3 kept a person (about 43, roughly 280
  accounts). Kept clients alone would need about 4 000 accounts.
- **Cost.** The collector runs on every registration and code exchange. Measured (Breach on #744, then here) with 7 000 people
  holding 6 ended ChatGPT clients each, 42 000 rows: the first form (the helper called per grant, then an array test per
  candidate) took 0.5 to 1 s a collection; this form (the stored flag, a left anti-join) about 130 ms median, against 0147's about
  47 ms on the same data. What is left is the ranking window over the flood's own ChatGPT grants; with few ChatGPT grants it is
  near zero.
- **md5.** `oauth_gc` before `b5d0423a7df82812106021e05488d9ad` (0147), after `d9262c411e083e9f8d970224a6cad17c`;
  `oauth_chatgpt_callbacks_only` `2a5c8c75b77b0a59556852a93c6b9cb4` (drift guard, end state, rollback).
- **Without it.** Everything works as under 0147; only ChatGPT's reconnect after more than a day fails, and the consent page then
  tells the person to remove the app there and add it again.
- **Replay.** `create or replace` plus revoke: a replay changes nothing. Re-running 0147 after 0161 is refused by 0147's own drift
  guard (it knows only 0093's and its own collector): apply the 0161 rollback first, re-run 0147, then 0161. Re-running 0093 puts
  0093's collector back: re-apply 0147, then 0161.
- **Number.** 0161, assigned to this branch: 0158 (#731) and 0159 (#745) are merged before it, 0160 belongs to another branch.
  Needs 0093 and 0147; names nothing of 0149's to 0159's. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0161_mcp_chatgpt_client.sql` (owner-applied): refuses a collector that is not 0161's, puts 0147's
  body back verbatim, drops the index, the column and then the helper.
- **Tests.** `tests/test_mcp_chatgpt_client_migration.py` (0147's body plus the two hunks, byte for byte; the hashes; the
  rollback; the numbering), `tests/security/test_sec_mcp_chatgpt_client.py` (a real PostgreSQL: the same client id signs in again
  after a disconnect and after the 90-day cap, its old token stays dead, it goes at 30 days; Claude, mixed, ordinary and unapproved
  clients still go after a day; 50 approve-redeem-revoke cycles keep 3; a shared workspace client stays while anyone ranks it; no
  API role calls either function; replay, rollback and drift guard). `tests/security/test_sec_mcp_free_tier.py` undoes 0161 before
  it replays and rolls back 0147.

## The MCP Studio tools' model list and result files (0162)

0162 (`0162_api_creative_models.sql`) adds two read-only API functions and changes nothing else (no table, column, row, policy, or
existing function body). They exist because the MCP server calls the database the way every `/api/v1` route does — the ANON key and
the API key's hash, never a session or the service key — and two things the Studio tools need had no door for such a caller.

- **`api_creative_models(p_key_hash, p_capability, p_request_id)`.** The models an API key's organization can generate with through
  the API, optionally for one capability: `sellable_models(capability, 'api')` (the set `api_creative_model_ok` lets
  `api_creative_create` sell), narrowed by creative_price's own entitlement rule (0156: `any`, or `paid` once the organization bought
  credits or is credits-exempt). Every other entitlement is refused at create, so it is not listed; nor is a model with none of the
  API's capabilities (a SQL array twinned with `API_CREATIVE_CAPABILITIES` in `command-center/lib/api/operations.ts`). No price: the
  quote is the only price a caller may act on. Answers `{ capability, models: [{ id, name, capabilities, availability, spec }] }`.
  api_begin with `creative.quote` (scope `creative:quote`; api_endpoint_scope is not replaced): a call past api_begin is logged as
  `creative.models`, one refused inside it (key, scope, request limit) as `creative.quote`. An unknown capability is 400
  `invalid_params`.
- **`api_creative_job_files(p_key_hash, p_job_id, p_request_id)`.** `api_creative_get`'s answer for a generation THIS key started
  (0062's ownership rule, word for word) plus `files`: each result asset not deleted and stored `local` (the only storage the signed
  file route serves), as `{ asset_id, kind, mime, variants, width, height, duration_s }`, so the server can sign
  `/api/media/file/...` links. Files only for a `completed` job: the worker attaches a job's assets while it is still processing and
  settles it afterwards, so a job that then failed (hold released, nothing charged) still names them (Breach BR-0162-1); any other
  status answers `files: []`. api_begin with `creative.get` (scope `creative:read`).
- **Who may call them.** `anon` only (PostgREST with the anon key), like every api_* entry point; not authenticated, not service_role,
  not PUBLIC. A connected app's access token (0093) is refused by oauth_ctx (`not_available_for_connected_apps`): oauth_endpoint_scope
  has no entry for creative.quote or creative.get. The last block asserts grants, definer and search_path.
- **md5.** `api_creative_models` `fe49adb06e9344c925e14c1bfbe3330d`, `api_creative_job_files` `31afb0f38cd2bbe7fa69ae983ebc5c8c`
  (drift guard, rollback).
- **Without it.** The MCP tools `list_models` and `get_generation` answer 503 `api_unavailable` naming 0162; `quote_generation` and
  `create_generation` call 0062's functions and work either way.
- **Number.** 0162. Needs 0031, 0035, 0038, 0062, 0075 (`creative_route_quote`) and 0124 (`model_is_available`); names nothing of 0147's to 0161's. The numbering tests of 0127, 0131 and 0133
  list it as reviewed.
- **Undo.** `docs/sql/rollback_0162_api_creative_models.sql` (owner-applied): refuses a body that is not 0162's, drops both.
- **Tests.** `tests/test_api_creative_models_migration.py` (the text, the hashes, the rollback, the numbering),
  `tests/security/test_sec_mcp_studio_tools.py` and `tests/security/test_sec_breach_mcp_studio_0162.py` (a real PostgreSQL),
  `command-center/tests/mcp-studio-tools.test.ts` (the MCP layer).

## The site's live public counters (0164)

0164 (`0164_public_site_stats.sql`) is **live on apply and still invisible**: it adds one table, four functions and (where pg_cron
is installed) one cron job; it replaces nothing and alters no existing table. The switch starts OFF, and while it is off the
public read answers `{"visible": false}` and nothing else. The one command, the k rule and what each number counts:
`docs/PUBLIC_STATS.md`.

- **`site_settings`.** One row (`id` is the constant true): `public_stats_visible boolean not null default false`, the stored
  measurement (`stats`, `stats_at`) and who last changed the switch. RLS on, no policy, every grant revoked (the service key
  included); the end state asserts no SELECT, INSERT, UPDATE or DELETE for anon, authenticated or service_role. A missing row reads as
  hidden.
- **`public_site_stats()`.** anon and authenticated. `{"visible": false}` while the switch is off, while nothing is stored yet, or
  while fewer than 5 customer workspaces are counted (**the k rule**: otherwise a customer could subtract its own numbers from the
  totals and read another tenant's). Otherwise the stored `videos_rendered` (a lower bound), `videos_uploaded_private`,
  `videos_approved`, `studio_generations` (counts), `last_run_at` (the UTC hour, null when nothing finished), `visible`, `as_of`.
  Nothing else: no organization, user, channel, video, title, and not `counted_orgs`. Anon never measures when nothing is stored;
  once the stored one is older than 15 minutes, one caller (advisory lock) measures again, and a read-only transaction answers
  without storing (`read_only_sql_transaction` is caught). The SQL editor and a signed-in platform owner/admin get a fresh
  measurement with `counted_orgs` and `min_counted_orgs`, and `visible` says whether the site would show it.
- **`set_public_stats_visible(boolean)`.** A signed-in platform owner/admin through `owner_guard` (0107: 42501 before anything is
  read, the second factor, 10 calls per 10 minutes) or the SQL editor. The editor is an allow-list: no API claims, and the role the
  call runs as (the SET ROLE, else the login) is not an API role and is a member of `postgres`; a role that merely inherits
  `authenticated` is not it. Not anon, not the service key. A change writes one `security_events` row (`site.public_stats`,
  `{from, to, via}`) in the same transaction; a call that changes nothing writes no event. Turning it on stores the first
  measurement. Not `app_audit_log`: its browser-side allow list (`audit_action_allowed`, 0145's body) would have to be replaced,
  and the owner's Security page already lists `security_events`.
- **`public_site_stats_refresh()`.** Internal (no API role): while the switch is on, measure and store. pg_cron runs it every 10
  minutes (`nightshift-public-site-stats`, scheduled as 0111 schedules its sweep: only when `cron.schedule`, `cron.unschedule` and
  `cron.job` exist, unschedule-then-schedule, a notice otherwise).
- **`public_site_stats_measure()`.** Internal (no API role). Also returns `counted_orgs`: distinct customer organizations with at
  least one row in any count.
- **Left out.** `default_org_id()` and every organization one of whose members is a bound `app_members` account (by user id, never by
  e-mail). Rows with no organization are not counted.
- **Freshness.** The site keeps an answer 5 minutes; a number on the page was measured at most about 15 minutes earlier with pg_cron
  and about 20 without.
- **md5.** `public_site_stats_measure` `e1fa900daf83fb55af871d3e118f8a31`, `public_site_stats_refresh`
  `022ce0de3feaebde13aadd1432fcc626`, `public_site_stats` `fe0dfed7b1abb856b161b35d8cfd6abb`, `set_public_stats_visible`
  `0b1793721bf2bb7aaad4c0eb248704e6` (drift guard, end state, rollback). The end state also asserts each is owned by `postgres`.
- **Without it.** The site's reader (`command-center/lib/server/public-stats.ts`) treats the missing function as hidden: no strip.
- **Number.** 0164, assigned to this branch; 0163 is held by an unmerged branch (#736) and is not reused. Needs 0007, 0016, 0017,
  0018, 0036, 0107, 0112 and 0116; names nothing of 0147's to 0162's. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
  `sec_db.ON_0124` lists it so that a lab sequence which leaves 0124 out and puts it back still ends on the newest file; the two lab
  tests that roll 0112 and 0116 back leave it out of their base (`sec_db.NEEDS_0112_0116`) and take it off and put it back around
  the rollbacks (`take_off_0164`, `put_back_0164`).
- **Undo.** `docs/sql/rollback_0164_public_site_stats.sql` (owner-applied): refuses a body that is not 0164's, unschedules the cron
  job, drops the four functions and the table.
- **Tests.** `tests/test_public_site_stats_migration.py` (the text, the hashes, the rollback, the numbering),
  `tests/security/test_sec_public_stats.py` (a real PostgreSQL: the switch refused for customers, anon, the service key and a role
  that inherits `authenticated`, with no audit row; one audit row per change by the admin and by the SQL editor; hidden answers
  `{"visible": false}`; hidden below 5 counted workspaces and shown at 5; the preview's `counted_orgs`; only the named keys; the
  operator's and staff workspaces left out; the last run to the hour; a null stays null; nothing stored means hidden; the 15-minute
  refresh; a read-only GET; replay, drift and rollback), `command-center/tests/public-stats.test.tsx` (the reader and the strip).

## The referral programme (0165)

0165 (`0165_referral_rewards.sql`) adds a referral reward that **pays nothing on apply**: it has its own switch,
`referral_enabled`, added OFF, which only a platform owner/admin can turn on (`set_referral_settings`, behind `owner_guard`).

- **What changes on apply.**
  1. `referral_enabled` is added off. 0092's `enabled` (true on live) only keeps links and joins working.
  2. 0092's sign-up milestone is switched **off**: `milestone_enabled` is added false, not copied. Sign-ups alone are farmable
     (`docs/security/LEDGER.md` BR-S-010). Live had 0 links and 0 joins, so nothing earned is lost.
  3. `referral_open_periods` starts empty: a join and a payment count only inside a period the reward was on (each on/off
     of `set_referral_settings` opens or closes one, in its audit). Nothing done while it was closed ever counts.
  4. `join_friend_invite` waits at most 2 s for its link lock (one hunk); the app retries once and keeps the cookie on a
     failure, and a password sign-in retries a kept cookie too.
  5. The lot trigger `credit_transactions_apply_lots` (0034) lets an `adjust` row name the lot it spends first
     (`nightshift.adjust_lot_first`, one hunk); only the referral clawback sets it.
  6. With pg_cron, `nightshift-referral-settle` runs `referral_settle_all(50)` every 5 minutes.
  No webhook, purchase, refund or reservation function, no policy and no existing row changes.
- **The rule.** A **payment** is a purchase or subscription row whose provider event (`transaction.completed` /
  `payment.succeeded`, processed) charged more than 0 **at full price**: paddle-webhook now appends ` · discounted (…)` to the
  event detail of any discounted or promo payment (an allowed promo books full credits at any paid share), and dodo-webhook
  credits no discounted payment. Rows that are not payments are skipped and use nothing up. A friend who joined under 0092's
  rules inside an open period qualifies with the **first payment ever** of a workspace they **created after their account
  was made** (anchored on the account, so a late-recorded join does not void it) and owned before paying, made inside an open
  period, within `referral_qualify_days` (60) of the account's creation, of at least `referral_min_credits` (1000), and, in
  USD, of at least `referral_min_credits / 2` cents (half the minimum's base price at 1 credit = 1 US cent).
  Void and recorded: a membership overlap (referrer in the paying workspace, friend in the link's) when it qualifies or when it
  is due (`member`; `org_members` has no history, so "was" is what those two moments saw), the same subscription customer on
  both sides (`same_payer`; one-time payments carry no payer identity and there is no device signal), a reversal during the hold
  (`refunded`). A reversal is a `credit_refunds` row, or the provider's own refund / chargeback / dispute event when a person
  must act (Paddle `adjustment.*` processed or rejected, Dodo `refund.succeeded`, `dispute.accepted|lost|expired`); the second
  kind is counted on the operator's panel (`reversed_by = 'event'`). The reward (`referral_credits`, 200, at most the minimum
  payment) is held `referral_hold_days` (30, at least 7), then paid as one `grant` row `referral-reward:<ref>` (an opaque uuid),
  at most `referral_monthly_cap` (10) per referrer per UTC month and `referral_daily_cap` (50) per UTC day; a capped reward waits.
  A reversal after the payout claws the reward back from its own lot first, as far as credits are available; the rest stays
  owed (`clawing`) and every later settle takes more (`referral-clawback:<ref>:<n>`, authored by the platform) until nothing is
  owed. The balance never goes negative.
- **A deleted referrer.** A link goes only with its owner's account (an operator step). Its referrals are then no longer
  settled (no payout to an account that is gone, a clawback still owed stays owed); `referral_admin` counts them as
  `orphaned` for the operator.
- **When it settles.** Under the referrer's link lock, in one order (link, advisory lock, account): `claim_referral_rewards()`
  (the Credits page, server-side, at most 60 an hour a person) and `referral_settle_all(n)` (service role and pg_cron; the n
  links settled longest ago, skip locked; one row in `referral_settle_runs` per call, kept 30 days). Joins older than the payment
  window plus two days are no longer looked at for a new referral.
- **Who may call what.** `my_referrals`, `claim_referral_rewards`: signed in, the caller's own only (counts, the link's
  workspace, the next hold's end as a day). `referral_terms`: anon and signed in. `referral_admin`: platform owner/admin (it also
  says whether the schedule exists, the last run and failures). `set_referral_settings`: `owner_guard('referral_settings', 10)`
  (second factor, rate limit), an `app_audit_log` row (`billing.settings`) and a `security_events` row (`referral.settings`, old
  and new values) in the same transaction. `referral_settle_all`: service role. `referral_settle_locked`,
  `referral_payment_reversed`, `referral_payment_paid`, `referral_was_open`: nobody. The three tables: RLS on, no policy,
  every privilege revoked, and the identity sequences' default grants revoked from the API roles.
- **md5.** Before: `friend_invite_pay_locked` `1cfc1f84f065d73e2cb7e84c18ca6ae2`, `my_friend_invite`
  `b26806d4fdc88a8453e939087d53184c`, `join_friend_invite` `549632bae0dbb002dc66200d7f6c0998`, `credit_transactions_apply_lots`
  `8ab35cff8ac8a145403b0e6eca735697`. After: `friend_invite_pay_locked` `eeae5e2f28b289aab7439beabede3a6f`, `my_friend_invite` `4717561b1b5c47f7e754118f15fa03ea`, `join_friend_invite` `8bc6fb874e4e65cf7378bddbfa3768d6`, `credit_transactions_apply_lots` `fcd28a68b841d8d539d3798f919a0d01`, `referral_payment_reversed` `c7ca11fcf4bf7e283ee77e43d7770a1b`, `referral_payment_paid` `0a53c4290c5046ccc3a6accdd46d9e9c`, `referral_was_open` `492d74b160d3bcf29d09a82d288e2a7e`, `referral_settle_locked` `aa1546a79a9a655bd278de1fad4d794a`, `my_referrals` `c0ff6ab6e0f6ee0df46c44ddb6b2df8f`, `claim_referral_rewards` `273fcc22a8e8116b86b57bcf03cf8ddb`, `referral_terms` `e2be2f76972e1e707e0ce4d52f47cf53`, `referral_admin` `6881c7fc37602e907793b0178bf5a73f`, `set_referral_settings` `c57ae2b4cd2d14bab35fbd85e9775cdf`, `referral_settle_all` `5e640e5905f7d7b974b47c4e4af5b748` (drift guard, rollback).
- **Without it.** The Credits page shows 0092's card and settings panel exactly as before; `/referral` says the programme is not
  available here; the pricing page does not mention it.
- **Number.** 0165 (assigned; 0163 and 0164 are other open pull requests). Needs 0018, 0020, 0021, 0034, 0042, 0092 and 0107;
  names nothing of 0108–0164. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0165_referral_rewards.sql` (owner-applied): locks `referral_rewards`, refuses while any row exists
  or a body is not 0165's; puts the four earlier bodies back byte for byte; unschedules the job; drops what 0165 added.
- **Tests.** `tests/test_referral_rewards_migration.py`, `tests/security/test_sec_referral_rewards.py` (a real PostgreSQL),
  `tests/security/test_sec_breach_referral_0165.py` (Breach: BR-0165-01..03), `tests/security/test_sec_friend_invites.py` (0092's
  milestone with its switch on), `command-center/tests/referrals.test.ts`, `command-center/tests/referral-ui.test.tsx`,
  `command-center/tests/friend-invites-routes.test.ts` (the join's retry), `command-center/tests/paddle-webhook.test.ts` (the
  discount mark), `command-center/tests/login-invite.test.ts` (a kept cookie retried after a password sign-in).

## Film Studio P1: films as drafts (0166)

0166 (`0166_films_core.sql`) adds five tables (`films`, `film_scenes`, `film_refs`, `film_takes`, `film_events`) and the four calls
a browser may make (`create_film_draft`, `save_film`, `archive_film`, `film_json`), plus internal helpers. It changes nothing that
exists: no existing table, column, row, policy, constraint or function body is touched. The plan and the data model are in
`docs/FILM_STUDIO.md`.

- **No spend.** No credit function is called and no creative or render job is created. A film stays `draft` (or `planned`) until
  0167 adds the quote and the start.
- **Who may call them.**
  - Writes: editors and above. Reads: any member, through column grants (never `request_hash`; a column a later migration adds
    is hidden until it is granted). The service key reads whole rows.
  - Another organization's film is P0002, exactly like a missing one.
  - Neither anon nor service_role calls any of the four.
  - No API role writes any of the five tables, the service key included.
  - `film_events` is append-only by trigger, even for the database owner. Its identity sequence is closed to every API role.
- **Limits** (`film_limits()`, repeated in the table checks):
  - 60 scenes, 3-30 s a scene, 1-3 shots, 1200 s in total;
  - a target of 60-1200 s;
  - a topic of 2,000 or a script of 40,000 characters;
  - 16 film-wide references and 8 per scene;
  - 50 open drafts and 500 films in all (archived ones included) an organization;
  - 5,000 recorded changes a film;
  - per person per hour, in the database: 30 creates, 240 saves, 60 archives (`take_web_rate`, buckets `db.film.*`; NS429
    `rate_limited`).
  - Erasure is the operator's, by a documented SQL-editor procedure (`docs/FILM_STUDIO.md`, "Storage and erasure"); nothing new
    is granted for it.
- **Models.** A model a person picks must be on sale for its role (`sellable_models`). A Seedance model (by id, a
  `video.seedance*` adapter, or a vendor model id naming Seedance) is refused as `model_not_offered`, under BytePlus §4.2.3. Other
  ByteDance models (Seedream) are judged like any other model: today they are terms-gated, so not on sale (`model_not_available`).
- **Text helpers.** `film_clean_text` and `film_text_ok` are 0131's `ads_clean_text` and `ads_text_ok`, byte for byte, under
  Film Studio's names. They are copies so that `rollback_0131` can still drop 0131's.
- **md5.** The replay guard pins every function body the file creates. The rollback pins the four browser calls.
- **Number.** 0166. 0163-0165 are taken by other open branches. It needs 0018, 0036, 0038, 0042/0087, 0047 and 0125. The numbering tests of
  0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0166_films_core.sql` (owner-applied). It refuses a body that is not 0166's, a later Film Studio
  migration, and any existing films unless its override line is set. Then it drops everything 0166 made.
- **Tests.**
  - `tests/test_films_core_migration.py`: the text, the grants, the limits, the hashes and the rollback.
  - `tests/security/test_sec_films_core.py`: a real PostgreSQL. It covers tenancy, direct writes, draft-only, versions and the
    lock, events, limits, frame roles, models, idempotency, replay and rollback.
  - `tests/security/sec_films_0166.py`: the shared lab's contract and seed.

## A refund that met a hold collects when the hold is released (0167)

0167 (`0167_refund_hold_recovery.sql`) closes Breach BR-0034-01: a buyer could keep refunded credits by holding them first.
`refund_purchased_credits` (0021, body of 0034) takes back at most what is available (balance - reserved) and recorded the rest as a
shortfall for good, as if spent. A workspace owner or admin can call `reserve_credits` for everything from the browser, have the
payment refunded (the refund then takes 0), and three hours later the unstarted hold is released and the credits are back. In the
lab: a 1000-credit pack refunded in full left 1100 credits where 100 should have been.

- **Design.** The held part of a shortfall stays open and is collected when those holds are RELEASED; a CAPTURED hold is real
  spending and the shortfall stands as recorded. Chosen over "the refund releases unstarted holds first", which leaves started holds
  (a run that fails after it began, or never settles) giving the credits back the same way, and cancels a queued run nobody cancelled.
  No run is interrupted or refused by this file.
- **`credit_refund_recoveries`.** One row per refund whose shortfall met open holds: `holds` (the job ids open at that moment),
  `owed` = least(shortfall, reserved), `collected` (taken back by a ledger row) and `lapsed` (the refunded purchase's own credits that
  expired while on the hold: gone from the buyer as the refund meant, so counted without a collection). 0 <= collected + lapsed <=
  owed; both only go up (one subscription lot can carry two payments after a mid-period upgrade: `lapsed` still never exceeds what
  expired, and no row passes its owed); a guard trigger refuses any other change, a delete or a truncate. RLS on, no policy, select for the service
  role only, like `credit_refunds`. A recovery is still open only while one of its holds is open (the documented query checks that;
  one whose holds were all captured is spent).
- **`credit_refund_recover()`.** AFTER INSERT trigger `credit_transactions_recover_refunds` on `credit_transactions`, for `release`
  rows only (every release goes through one: `credit_release_locked` and the unused part of `capture_credits`). It fires after
  `credit_transactions_apply_lots` (same-event triggers fire in name order; the end state checks the catalog holds exactly those two
  row-level AFTER INSERT triggers, in that order), so the hold's lots are back, and the ones that ran out expired, before it looks.
  Per release it takes least(what is still owed, what THIS release gave back to lots that are still live, what is available), oldest
  refund first, only for holds that were open when the refund was recorded. "Gave back to live lots" is read from the release row's
  own `credit_lot_moves`: Lens (#766) showed that a cap on `available` alone let a refunded pack that expired while held be paid
  again from a pack bought afterwards. A later hold, on later credits, is never touched: a refund does not eat the next purchase.
  It spends FROM the lots that release gave back (the refunded purchase's own first, then spend order): one `refund` ledger row
  per lot, each naming its lot for the lot trigger, so a later purchase's lot never pays (Lens round 2). Each row is written with
  `created_by` null (the platform's act, also when the release ran inside the buyer's own `reserve_credits`). A release that meets
  no open recovery returns after one probe of `credit_refund_recoveries_open_idx`; the moves queries are narrowed by the hold's
  job (`credit_lot_moves_job_idx`), since `credit_lot_moves` has no index on `txn_id` (Lens measured 21.9 ms a release at 200k moves
  without it). Runs under the account lock the releasing function already holds, so it serialises with `reserve_credits` and the
  refund.
- **`credit_transactions_apply_lots`.** 0165's body (0034's plus the referral programme's `adjust` hunk) plus marked lines: a
  `refund` row's spend may name its first lot through `nightshift.refund_lot` (a lot id, this organization's lots only). Unset, which
  is every other caller, it is 0165's behaviour exactly. 0165's `nightshift.adjust_lot_first` is not reused: it names an external id
  for an `adjust` row, while a collection must name a lot id (a grant or carry-over lot has no external id) for a `refund` row. Each
  setting is read only in its own kind's branch, and each writer sets it transaction-local just before its insert and resets it
  right after, so the two cannot meet.
- **Known gap, by design.** A future path that refunds a CAPTURED run (credits given back after `capture_credits`) is not a release
  and would reopen the leak; it must consult `credit_refund_recoveries` or go through a release row. None exists today (0030's
  download refund restores a charge that had no hold).
- **Webhooks.** `supabase/functions/_shared/paddle.ts` and `dodo.ts` read `on_hold`: the log line and the event row say "N on hold, taken back
  if the hold is released and not spent" and only the rest "already spent"; without 0167 (no `on_hold`) the shortfall is one figure,
  not called spent.
- **`refund_purchased_credits`.** 0034's body, line for line, plus lines marked `-- 0167`: the recovery row, `on_hold` in the answer
  (and in a duplicate's), and a ledger note that says how much is on hold instead of calling it spent. Same signature, refusals,
  idempotency on refund_id and grants.
- **md5.** `refund_purchased_credits` before `766daf507d4e70711b8622aebbea7705` (0034), after `1024ac369b7a18830ac547e41c5ca89e`;
  `credit_transactions_apply_lots` before `fcd28a68b841d8d539d3798f919a0d01` (0165), after `6098f97a7630bed24807bb7c5ef6eefe`;
  `credit_refund_recover` `0c16bb426e63c1bc1d9fa2518f45b921` (drift guard, end state, rollback).
- **Not changed here.** `api_refund_topup` (0031, the API balance in cents) and `owner_reverse_grant` (0107) apply the same "available
  only" rule to their own tables; reported for their own ledger rows.
- **Number.** 0167 (provisional; 0163 is held by another open branch; 0164 to 0166 are merged). Needs 0020, 0021, 0034 and 0165 (the lot
  trigger's latest body); names nothing else of 0035 to 0166. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0167_refund_hold_recovery.sql` (owner-applied): refuses bodies that are not 0167's, drops the trigger
  and its function, puts 0034's `refund_purchased_credits` and 0165's `credit_transactions_apply_lots` back verbatim. The table stays as the
  record.
- **Tests.** `tests/test_refund_hold_recovery_migration.py` (the text, the hashes, the rollback, the numbering),
  `tests/security/test_sec_breach_refund_hold.py` (the attack) and `tests/security/test_sec_refund_hold_recovery.py` (partial holds,
  capture, two refunds, a later hold, lots expiring on the hold, a subscription payment, a never-settled started hold, a storyboard
  undo, created_by, the open query, the lot a collection spends, plan checks that no query scans `credit_lot_moves` and that a
  release with no recovery reads nothing, replay, concurrency with `reserve_credits`; a real PostgreSQL);
  `command-center/tests/paddle-webhook.test.ts` and `dodo-webhook.test.ts` (the wording).

## An API top-up refund that met a hold collects when the hold is released (0168)

0168 (`0168_api_refund_hold_recovery.sql`) closes BR-0031-01 (Lens, high): a customer could keep a refunded API top-up by holding it
first. `api_refund_topup` (0031, never redefined) takes back at most what is available (`balance_cents - reserved_cents`) and recorded
the rest in the ledger note as "already spent", for good. The customer's own API key makes the holds (`api_create_video`,
`api_request_download`) and can make the runs fail on purpose (a channel pointed at an unavailable voice stops before spending, rule
4); a failed job, a failed download and a hold that never starts or never settles in 24 hours are released in full. In the lab: a
5000-cent top-up refunded in full left a balance of 5000 where it should have been 0.

- **Design.** 0167's for site credits (BR-0034-01), carried over to the API balance. The held part of a shortfall stays open and is
  collected when those holds are RELEASED; a CAPTURED hold is real spending and the shortfall stands. No run is interrupted.
- **`api_refund_recoveries`.** One row per refund whose shortfall met open holds: the refund id and its ledger row, the top-up, the
  organization, the reason, `holds` (the refs open at that moment), `owed` = least(shortfall, reserved, the open holds' sum) and
  `collected` (0 <= collected <= owed, only goes up; a guard trigger refuses any other change, a delete or a truncate). RLS on, no
  policy, select for the service role only.
- **`api_refund_recover()`.** AFTER INSERT trigger `api_ledger_recover_refunds` on `api_ledger`, for `release` rows of a hold only
  (every release goes through `api_settle_locked`: the job trigger, the download trigger, the 24-hour expiry). It first checks the row
  is a real release (the hold says `released`, same amount). A release pays at most what it gave back, shared across the refunds that
  met that hold in the order they were recorded, and never more than is available: least(still owed, left of this release,
  available). API cents have no lots and never expire, and nothing can lower the balance under a hold, so a release gives back
  exactly its amount; this cap is what keeps a top-up made after the refund whole (the Lens finding on 0167). Only holds open when
  the refund was recorded pay. The collection is a `refund` row in `api_ledger` (`source_external_id` = the top-up, `hold_ref` = the
  hold, `requested_cents` null so later refunds of the same top-up still add up correctly) written with `created_by` NULL: a release
  can run inside the customer's own API call (the lazy expiry), and `api_log` would have stamped the customer's id on it.
- **`api_refund_topup`.** 0031's body, line for line, plus lines marked `-- 0168`: the recovery row, `on_hold_cents` in the answer
  (and in a duplicate's), and a ledger note that says how much is on hold instead of calling it spent. Same signature, refusals,
  idempotency on the refund id, `paid_total_cents` arithmetic and grants (service role only).
- **The webhook.** `supabase/functions/_shared/paddle.ts` reads `on_hold_cents` and words the shortfall as on hold or spent; when the
  database does not answer it (0168 not applied) it says it does not know which, rather than "spent" (rule 5). A duplicate delivery is
  not logged again: its on-hold figure is the one recorded when the refund first landed.
- **Still open.** The footer's query lists a recovery only while `collected < owed` AND one of its holds is still `open`; a
  refund whose holds were all captured keeps `collected < owed` for good and is a shortfall that stands, not an open one.
- **Locks.** First run: CREATE TRIGGER, SHARE ROW EXCLUSIVE on `api_ledger`. A re-run: DROP TRIGGER of the existing trigger,
  ACCESS EXCLUSIVE on `api_ledger` (reads wait too) until commit; `lock_timeout` 5s.
- **md5.** `api_refund_topup` before `a9d2287173b12b704808e7b3747b05e0` (0031), after `74ea95ec27564e57b7b989a906a15842`;
  `api_refund_recover` `785ca1a1df7d72192bd98dbfd9122a37` (drift guard, end state, rollback).
- **Not changed here.** `owner_reverse_grant` (0107, site credits) has the same "available only" rule (BR-0107-01, low); fixed by 0172,
  whose collection sits next to 0167's trigger on `credit_transactions` so that the two never both collect one release.
- **Number.** 0168 (provisional; 0163 to 0167 are held by other open branches). Needs 0031; names nothing of 0032 to 0167. The
  numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0168_api_refund_hold_recovery.sql` (owner-applied): refuses bodies that are not 0168's, drops the
  trigger and its function, puts 0031's body back verbatim. The table stays as the record.
- **Tests.** `tests/test_api_refund_hold_recovery_migration.py` (the text, the hashes, the rollback, the webhook wording, the
  numbering), `tests/security/test_sec_breach_api_refund_hold.py` (the attack) and `tests/security/test_sec_api_refund_hold_recovery.py`
  (partial holds, the 24-hour expiry, capture, two refunds, one hold met by two refunds with a later top-up, one refund over two
  holds, a later hold, a download hold, held cents not consumable, a forged release, replay, the record's guard, who wrote the
  collection, concurrency with `api_create_video` in both orders; a real PostgreSQL), `command-center/tests/api-topup-webhook.test.ts`.

## An HD download through the public API audits a name the audit list has (0170)

0170 (`0170_api_download_audit.sql`) is a **fix, live on apply**: from the moment it is applied, an API key's download request
(`api_request_download`, behind `POST /api/v1/videos/{id}/downloads`) can create a paid, redownload or exempt download again.

- **The failure.** `api_request_download` (0031, rebuilt by 0042 and 0147) audited itself as `video.download`. Since 0087,
  `app_audit_log_stamp` refuses an action that `audit_action_allowed()` does not list with 22023 for the anon and
  authenticated roles, which every API call runs as; the list has `video.download_request` and never had `video.download`.
  The function's own `exception when others` turned that into `500 internal_error` and undid its block: no request row, no
  hold, no ledger row, nothing charged. Only the "reused" answer (no audit row) worked. It failed closed, but the paid
  feature did not work at all.
- **The change.** One hunk in `api_request_download`: it audits `video.download_request`, the name the Command Center's own
  download route writes for the same act (`command-center/app/api/downloads/route.ts`). The row still carries `via=api` and
  the key's id. The audit list is not changed (nothing is widened); no reader expects `video.download` (the audit page
  prints the action as stored). Every other line, price, hold, refusal and grant is 0147's.
- **md5.** `api_request_download` before `055003f8a2fb5390bbd1b5f7820e6e2e` (0147), after `b59ca71d0e0379e217e47a6987c9ed0c`
  (drift guard, end state, Verify, rollback).
- **Number.** 0170, provisional (0169 is held by an open pull request, #750); it is changed at merge if another branch takes it.
  Needs 0031, 0042, 0087 and 0147; names nothing of 0148 to 0169. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Replay.** `create or replace`, then revoke and grant: a replay changes nothing. Re-running 0147 after 0170 is refused by
  0147's drift guard: apply the rollback first, re-run 0147, then 0170 again.
- **Undo.** `docs/sql/rollback_0170_api_download_audit.sql` (owner-applied): refuses unless the body is 0170's, puts 0147's back
  byte for byte with its grant (anon only). It brings the failure back.
- **Tests.** `tests/security/test_sec_api_download.py` (a real PostgreSQL: a paid download with its hold, ledger and audit row,
  the same request reused without a second hold, a redownload, the exempt organization, another organization's key, the list
  not widened, replay, rollback, drift guard), `tests/test_api_download_audit_migration.py` (0147's body plus one hunk),
  `tests/test_audit_actions.py` (every `api_audit(...)` action in a function's latest body is on the list).

## Film Studio P2: the price of a film, one hold, and the settle path (0171)

0171 (`0171_films_money.sql`) lets a film be priced and started, and gives P3's worker the calls that settle it. Nothing in it calls a
provider or creates a creative or render job, and no credit function body is replaced. The plan is in `docs/FILM_STUDIO.md`,
"Money (P2)".

- **Adds.**
  - `film_studio_settings`: the switch, OFF, set only by `set_film_studio_enabled` (owner_guard or the SQL editor; audited).
  - `film_quotes`: the stored quotes, 30 minutes each.
  - `film_segments`: one funding hold of a film, its assembly line with the captions, and the worker's lease.
  - `org_film_settings`: a per-film cap, none by default, and how many films run at once, 1 by default.
  - The money columns and the provider task id of `film_takes`.
  - `creative_jobs.film_take_id` with `payer = 'film'`, set exactly together and never with a hold of its own.
  - `'queued'` in `films_status_check`.
- **The browser's calls.**
  - `quote_film(film, version)`: editors and above.
  - `start_film(film, quote_id, idempotency_key)`: owners and admins; in the exempt organization a platform owner or admin.
  - Both are rate-limited in the database: 120 quotes and 10 starts a person an hour (`db.film.*`).
  - A start refused after it is counted is answered as `{ok: false, reason, code, detail}`, so it still counts (BR-0171-01).
- **The price.**
  - Key frames and clip shots are priced by `creative_price` (0159). A clip is priced against a library picture as a stand-in, the
    50 newest only, following 0073's rule.
  - Narration is the tts rate times every character, never less than its minimum once per 4,000-character call.
  - Assembly with captions is `film_assembly_minute` times the planned minutes. **No price row is seeded.**
  - Any line that cannot be priced makes the total and the quote id NULL and names the reason. A character counts as all of its
    pictures against the reference limit.
- **The hold.** One per segment: `reserve_credits(org, 'fm-<segment id>', total)`. Capture is once, at settle, never above the hold.
  0034 is unchanged, and the quote reports the run slot the film takes and for how long.
- **Charges (the Studio's rule).**
  - A take that delivers is charged its line. A clip delivers when its file's recorded length (`media_assets.duration_s`, written at
    registration) is at least 90% of the confirmed seconds; otherwise it counts as failed.
  - Each take gets one automatic retry within its line, charged once, on success.
  - A take that delivers nothing is 0, whatever the vendor did (a moderated or failed task, a partial narration, a lost worker); the
    platform absorbs the vendor's charge, and the basis records it.
  - The assembly is charged by its registered file's recorded length.
  - A result is kept only when accepted: a rejected or lost take's files are soft-deleted in the same transaction.
- **Safety.**
  - A segment that charged nothing and made nothing returns its film to `draft`, and its never-begun takes are removed.
  - No take begins once the hold is gone, or while a 0167 refund recovery waits on it.
  - The claim and the sweep isolate each segment in its own subtransaction, and a skipped one leaves a `segment_skipped` event.
  - A segment's leases are capped (3), and after that what it left in flight is ended as `worker_lost`.
  - Past the deadline plus 2 hours (22 h, inside 0020's 24) the sweep ends what is in flight and settles while the hold is open.
- **Replaced constraints.** `films_status_check` (0166's plus `'queued'`) and `creative_jobs_payer_check` (0036's plus `'film'`).
  The drift guard compares the exact set of quoted words with the earlier file's and 0171's. Replaying 0166 or 0036 after 0171 would
  put the narrower check back: replay 0171 after it (the lab's `sec_db.take_off_0171` / `put_back_0171`).
- **Locks while applying.** ACCESS EXCLUSIVE on `creative_jobs`, `films` and `film_takes` until commit, and one scan for each new
  check. `lock_timeout` is 5 s, so the file fails rather than queueing behind the creative worker. Apply it as one transaction.
- **md5.** The replay guard and the rollback pin every function body the file creates; the end state pins the money ones.
- **Number.** Provisionally 0171 (0169 is another open pull request; 0170 is the API download audit). It needs 0020, 0034, 0036,
  0052, 0094, 0107, 0159, 0166 and 0167. The numbering tests of 0127, 0131 and 0133 list it as reviewed. 0166's header says "0167"
  for this phase: that was the plan's number, and a merged file is never edited.
- **Undo.** `docs/sql/rollback_0171_films_money.sql` (owner-applied). It refuses in any of these cases:
  - a segment is live;
  - a `payer = 'film'` job exists;
  - a body is not 0171's, or a later function reads `film_segments`;
  - any segment exists and its override line is not set.

  The credit ledger keeps every movement either way.
- **Tests.**
  - `tests/test_films_money_migration.py`: the text, the grants, the hashes, the constraints, the rollback.
  - `tests/security/test_sec_films_money.py`: a real PostgreSQL.
  - `tests/security/test_sec_breach_films_money.py`: Breach, BR-0171-01 and the refused attacks.
  - `tests/security/sec_films_0171.py`: the shared lab's contract and seed.

## An owner's grant reversal that met a hold collects when the hold is released (0172)

0172 (`0172_grant_reversal_hold_recovery.sql`) closes BR-0107-01 (low): a grant reversed while part of it was on hold was reversed only
in part, for good. `owner_reverse_grant` (0107, never redefined) takes back at most the part of the grant's lot that is neither held
nor unavailable and records the rest as a shortfall under the one-per-grant external id `owner-reverse:<grant id>`, so a retry answers
duplicate. A hold is not spending: when the run never starts, fails or is cancelled, the hold is released and the workspace keeps those
credits. In the lab: 100 granted, a run holding all but 30, the reversal takes 30, the hold is released, the workspace kept 70. It
needs a platform owner or admin to make the grant and the reversal, hence low.

- **Design.** 0167's for refunds, carried over to reversals. The held part of the shortfall stays open and is collected when those
  holds are RELEASED (expired, failed, cancelled, the unused part of a capture); a CAPTURED hold is real spending and the shortfall
  stands. No run is interrupted.
- **`credit_grant_reversal_recoveries`.** One row per reversal whose shortfall met holds on the grant's own lot: the grant's ledger
  row (primary key), the reversal's ledger row, the grant's lot, the organization, `holds` (the jobs that had credits of that lot in
  `credit_hold_lots` at that moment), `owed` = least(shortfall, the lot's held credits, what those holds had of it), `collected` and
  `lapsed` (0 <= collected + lapsed <= owed, only go up; a guard trigger refuses any other change, a delete or a truncate). RLS on,
  no policy, select for the service role only.
- **`credit_grant_reversal_recover()`.** AFTER INSERT trigger `credit_transactions_recover_reversals` on `credit_transactions`, for
  `release` rows of a hold. By name it fires after the lot trigger and after 0167's `credit_transactions_recover_refunds`. It spends
  only the grant's own lot, and per release at most least(still owed, what THIS release gave back to that lot less what was spent from
  the lot since the release row (0167's collector, which may have taken some of it for a refund), what is free in the lot, what is
  available), so the two collectors never both collect one release's credits and a purchase made later is never eaten. Only holds
  on the lot when the reversal was recorded pay. The grant's own credits that expired on the hold count as `lapsed`, with no ledger
  row. The collection is an `adjust` row (no external id, a note naming the grant and the hold) written with `created_by` NULL: a
  release can run inside the member's own `reserve_credits` (the lazy expiry), and `credit_log` would have stamped their id on it.
- **`owner_reverse_grant`.** 0107's body, line for line, plus lines marked `-- 0172`: the recovery row, `on_hold` in the answer, in a
  duplicate's and in the audit entry (three of 0107's lines are replaced whole by marked lines that keep their text), and its own
  `adjust` row now spends the grant's own lot first (0107's "lot attribution" limit). Same signature, refusals, idempotency and grants.
  A grant that is ALL on hold still answers `nothing_to_reverse` and records nothing: nothing was made final, so the owner reverses it
  once the hold has settled.
- **`credit_transactions_apply_lots`.** 0167's body plus marked lines: an `adjust` row may name its first lot by id
  (`nightshift.reverse_lot`, this organization's lots only); unset, it is 0167's behaviour exactly.
- **Known residual.** When a refund (0167) and a reversal met the SAME hold, 0167's collector goes first and spends the release's lots
  in spend order, the grant's lot included; the reversal then collects only what is left of its lot in that release. Nothing is
  collected twice, but in that case the refund may take the grant's credits instead of its own pack's, and the workspace keeps up to
  the reversal's held part (pinned in `test_a_refund_and_a_reversal_that_met_one_hold_together_take_no_more_than_it_gave_back`). The
  fix would be in 0167's lot order; firing this collector first instead was rejected, because 0167's per-release cap does not see
  what this one took and could then collect one release twice.
- **The Command Center.** The reverse dialog words the shortfall as on hold or spent from `on_hold`, and says it does not know which
  when the answer has no `on_hold` (0172 not applied), rather than "spent" (rule 5).
- **Locks.** One new table; CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `credit_transactions`, a re-run's DROP TRIGGER takes ACCESS
  EXCLUSIVE until commit; `lock_timeout` 5s.
- **md5.** `owner_reverse_grant` before `4c701e7930d213f6f1ba84485c366a36` (0107), after `de3893bbaba50d48edfa694baf39533f`;
  `credit_transactions_apply_lots` before `6098f97a7630bed24807bb7c5ef6eefe` (0167), after `aec752383dd2c5cf3621ee273a677fe0`;
  `credit_grant_reversal_recover` `e58362bc86d0b47c042f0bc8a2e15319` (drift guard, end state, rollback).
- **Number.** 0172 (0171 is held by an open branch that touches neither function). Needs 0020, 0034, 0107, 0165 and 0167. A replay of
  0167 after 0172 refuses (its guard and end state know only two collectors' worth of the ledger): take 0172 off first; the lab's
  `sec_db.take_off_0167` / `put_back_0167` do it through `take_off_0172` / `put_back_0172`. The numbering tests of 0127, 0131 and
  0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0172_grant_reversal_hold_recovery.sql` (owner-applied): refuses bodies that are not 0172's, drops the
  trigger and its function, puts 0107's `owner_reverse_grant` and 0167's lot trigger back verbatim. The table stays as the record.
- **Tests.** `tests/test_grant_reversal_hold_recovery_migration.py` (the text, the hashes, the rollback, the numbering, the ledger
  row), `tests/security/test_sec_breach_owner_reverse_hold.py` (the finding, now passing) and
  `tests/security/test_sec_grant_reversal_hold_recovery.py` (a partial hold from the grant's own lot, an expired lot, two holds with
  a later purchase, capture, a later hold, replay of the reversal / release / expiry / migration, the record's guard, the collection
  inside the member's own reserve written as the platform's, one release met by a refund and a reversal, credits restored into the
  lot not paid twice, concurrency with `reserve_credits` in both orders; a real PostgreSQL).

## The seven cleared models on sale (0173)

0173 (`0173_open_cleared_models.sql`) is **live on apply** and moves money: it writes 18 `credit_prices` rows and sets
`model_registry.availability = 'beta'` and `entitlement = NULL` for seven models. It replaces no function, policy, grant or constraint.

- **What opens.** Ideogram 3, 4 and 4.5; MiniMax H3, H3 Highspeed, H3 Lite and H3 Max: every registry entry with no `terms_gate`, a
  successful probe of its current call, a vendor figure for every priced variant, no shutdown date passed, no `blocked_countries`, and
  `api_exposure` `web_only` (so the API and MCP never list them), less the two below. The 68 terms-gated entries stay hidden; 0035's
  CHECK would refuse the file if it tried otherwise.
- **Not opened, by name: Runway gen4.5 and gen4_turbo.** They pass every gate above, but they wait for the likeness-consent step:
  Runway's terms want a photo-consent confirmation on an i2v upload, and the Studio has none yet (the owner's decision, 2026-11-14).
  No gate is loosened for that; the file simply does not name them. They stay hidden and unpriced, and `schemas/model_registry.json`
  keeps their plan tiers (`models_video:ultra`, `models_video:premium`) exactly as on main. A file of their own opens them, after the
  consent step and the export-embargo country decision.
- **Prices.** Priced from credit_prices; see the owner's private pricing notes. The repository's convention (`docs/sql/prices_2026_10_01.sql`,
  `prices_defaults_2026_10_03.sql`) applies: no unit sells below its registry vendor figure, rounded up per job. A model priced by variant has a row per
  variant (`model_<id>_<unit>_<768p|2k|480p|low|medium|high>`), which is all a quote of it reads; its base row (what `sellable_models`
  joins to list it) is the default variant's figure. The figures are the registry's own list prices (`confirmed: false`); the file
  compares each with the registry before it writes, and refuses if one moved.
- **ideogram-3 keeps its existing live row** (0173 never overwrites a row); the owner may change it via a docs/sql script. The other
  rows already live for these units (four, counted when the file still named nine models) sell at or above this file's price, so the
  never-below guard does not stop the apply.
- **Each probe proved one call only.** MiniMax H3 and H3 Highspeed i2v at 768p, H3 Lite and H3 Max i2v at 480p, Ideogram 3 and 4
  t2i, Ideogram 4.5 t2i at low. Not proven so far, yet sold at their own figures: every MiniMax t2v call, MiniMax H3 2k, H3 Highspeed 480p, H3 Lite 768p, H3 Max 768p, and Ideogram 4.5 medium and high.
- **Entitlement: the diagnosis.** `creative_price` refuses every entitlement except `any` (NULL) and `paid`, for every organization
  whatever its plan; 0034's `model_tier_allowed()` and its plan tiers are seeded but never called (`entitlement_keys` marks
  `models_*` `planned`). Availability alone would sell to nobody, and would take the models from the operator (0139's preview passes
  only a `hidden` model; a beta model's quote asks the entitlement even in the exempt organization). So the seven get NULL, here and in
  `schemas/model_registry.json`; the tiers they had are in the rollback. Enforcing tiers is its own change (creative_price, the
  entitlement keys and both Studio gates together), and with no plan purchasable yet it would open only the two `basic` models.
- **Free credits.** 100 welcome credits per mailbox (0042); every unit sells above its vendor figure (the exposure: Priced from credit_prices; see the owner's private pricing notes.). A failed or refused job returns its
  whole hold, so vendor money spent on a failed task (whether MiniMax bills one is not stated; not verified for Ideogram) is
  not bounded by those 100 credits. No cap is applied by this file.
- **Drift guards.** Each of the seven must be present, the same adapter / vendor model / credit unit / capabilities / variant set /
  default as written, with no `spec.vendor_model_by_capability` (a capability calling another vendor model would sell at this figure),
  verified, ungated, not disabled, not shut down, web only, and carry either its old tier or NULL. A price row that already exists is
  never overwritten: kept when it sells at or above this file's price (with a NOTICE), refused when below. An empty registry (a fresh
  deployment, the lab's build) writes nothing. The end state is asserted in the same block: every unit at or above its required price, the seven beta with NULL
  entitlement, listed by `sellable_models('web')` and not by `'api'` or `'mcp'`, nothing terms-gated on sale.
- **Not checked by SQL (owner).** The Privacy Policy now names Ideogram and MiniMax as Studio processors and says MiniMax may use
  inputs and outputs to improve its models (the registry's "before a sale" note); Runway is not named, since it is not opened. Still
  open: MiniMax's Uzbekistan billing.
- **Number.** 0173, first written as 0160, then 0163: renumbered each time so the files merged meanwhile land first, since the
  Supabase integration applies a file on merge only when its number is above the latest applied one, and this file waits for the
  owner's decision. Live and main end at 0170; 0171 and 0172 belong to open branches. None of 0158 to 0170 writes `model_registry` or
  `credit_prices` or replaces `sellable_models`, `model_is_available` or `model_past_shutdown`; 0159's `creative_price` refuses a clip
  length the model does not list, and the seven list theirs. Once it applies, 0166's Film Studio drafts can pick the seven (a draft
  spends nothing). The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Undo.** `docs/sql/rollback_0173_open_cleared_models.sql` (owner-applied): the seven back to `hidden` with their tiers, and only the
  price rows 0173 wrote (note `0173:`) whose rate and margin nobody changed are deleted. The operator's preview works again as before.
- **Tests.** `tests/test_open_cleared_models_migration.py` (the seven are exactly the openable entries less Runway, Runway absent and
  still tiered, no gated id in the file, every price is the registry figure at the file's markup, every variant priced, base rows at the
  default, the file's entitlement NULL, the rollback's tiers and rates, rows only, the 100 welcome credits, the Privacy Policy row) and
  `tests/security/test_sec_open_cleared_models.py` (every variant quoted to a customer at the file's price and never below its vendor figure, a customer held at
  the quote, the catalog and not the API or MCP, Runway seeded verified and ungated yet left hidden, unpriced, unlisted and refused,
  gated models refused and un-openable, the operator exempt and not a preview, availability alone sells to nobody, the drift guards,
  replay, rollback and re-apply).

## Rights acknowledgement: a recorded "I take responsibility" before restricted models (0174)

0174 (`0174_rights_acknowledgement.sql`) puts an explicit, recorded acknowledgement in front of a model whose provider (or the law)
makes the person confirm their rights to an input (`docs/RIGHTS_ACKNOWLEDGEMENT.md`). It opens no model and changes no availability.

- **Evidence.** Runway's Terms §4.2 (registry `terms_notes`): no photograph of another person without their permission; the i2v
  upload needs a photo-consent confirmation. Our Terms §6.2. Nothing in the job start path knew a model needs a confirmation, so the
  only way to keep such a model honest was to keep it hidden.
- **Tables.** `rights_acknowledgement_kinds` (three kinds, each with its current text version). `rights_acknowledgements`
  (append-only: no API role writes it, a trigger refuses UPDATE / DELETE / TRUNCATE even for the owner; members read their
  organization's rows): who, which organization, kind, text version, **the language the words were read in** (`locale`, en / ru /
  uz, from the first row), the input asset and its sha256.
- **The requirement.** `model_registry.requires_acknowledgement text[]` (default empty; `{likeness_photo}` on `runway-gen4.5` and
  `runway-gen4-turbo`). A model requires the union of the column and `spec.requires_acknowledgement`. The column **only grows**:
  `model_registry_requirement_guard` (BEFORE INSERT OR UPDATE, not SECURITY DEFINER) copies every known kind the spec names into it,
  so a sync that later drops the spec list keeps the column, and refuses an UPDATE that removes a kind for every role but the
  table's owner (the service key has a table-level UPDATE since 0035). A spec value of any other shape, or an unknown kind, fails
  closed (a kind nobody can acknowledge).
- **The calls.** `acknowledge_rights(kind, text_version, subject, locale)`: the only write path; refuses an unknown kind or
  language, a stale version (NS409), another organization's file (as a missing one), and more than **60 new rows a person an hour**
  (NS429 `acknowledgement_limit`; a replay is answered first and counts nothing). `rights_acknowledgement_status(org, model,
  subjects)`.
- **The gates.** `create_creative_job` (0075 + two hunks): after the price (a model refused anyway never asks) and before the
  ceiling, the hold and the job row, `acknowledgement_required` (NS400 / HTTP 428) for an input (`source_asset_id`, `end_asset_id`)
  this person has not acknowledged in this organization at the current version. `workflow_quote_steps` and `start_workflow_run`
  (0073 + one hunk each): a workflow step whose model requires an acknowledgement and takes a media input is refused at the quote
  and at the start, before any hold (an earlier step's output cannot be acknowledged in advance, and a later step may run in another
  member's session). `api_creative_refusal` (0124 + one hunk): the API answers 428 `acknowledgement_required`, "confirm in the
  Studio". Covered: every `creative_jobs` row (the Studio, the API and MCP, region edit, workflow steps). Not covered here: the Film
  Studio's path (0171, open), handled in a follow-up.
- **md5.** `create_creative_job` 4c74918fd9d938c8fe4f5a3d26a09d84 → 88107b00b0a8c143606ed17f5898c98d; `workflow_quote_steps` 48250650e93a951c6b64cad1e73e8a24 → 8f9f42da9844571a18a285d87bcffc84;
  `start_workflow_run` c60ad7a487f7f11bf080ef92629c436e → 8b3c4b4afbc19e6f336c09b4692ad7ed; `api_creative_refusal` 2253296a9c1ac2e5de3c25a2a726398e → e6ec45d0d912389a05eb2d40261c2c2a (drift guard, end
  state, Verify, rollback). The new functions are pinned in the drift guard too (absent, or 0174's own).
- **Number.** 0174; 0171 to 0173 are held by open pull requests. It names nothing of them, but it auto-applies on merge, so it merges
  after them. Needs 0018, 0035, 0036, 0038, 0073, 0075 and 0124. The numbering tests of 0127, 0131 and 0133 list it as reviewed.
- **Replay.** 0174 replays onto itself and changes nothing. **The earlier files do not protect it**: 0075's guard is a `position()`
  check that 0174's body also passes, and 0073 has no guard, so re-running 0075 or 0073 over 0174 SILENTLY restores the old body
  and removes the gate (measured: `tests/security/test_sec_rights_acknowledgement.py`). Re-running 0075 also puts its own
  `api_creative_refusal` over 0124's, after which 0174 refuses to go back on by itself. Undo 0174 first (its rollback), and after
  any manual replay run 0174's Verify query: its `job_gate` column reads false when the gate is gone. 0124's drift guard does
  refuse 0174's `api_creative_refusal`, so the lab takes 0174 off (`sec_db.take_off_0174`) before replaying 0124 and puts it back
  after; `sec_db.ON_0124` leaves it out of every sequence that leaves 0124 out.
- **Undo.** `docs/sql/rollback_0174_rights_acknowledgement.sql` (owner-applied): refuses unless all four bodies are 0174's, puts
  the earlier four back byte for byte with their grants, drops the five 0174 functions and the requirement guard's trigger, and
  **keeps the record** (the tables with their rows and append-only triggers, the column). Apply it only while no model that
  requires a kind is on sale.
- **Tests.** `tests/security/test_sec_rights_acknowledgement.py` (a real PostgreSQL: refusal without, success with, one file each,
  another person's and another organization's do not count, an old version does not count, refusal before any hold, the language
  recorded, the hourly cap, the service key cannot lower the requirement, a sync that drops the spec keeps the column, a wrong
  shape fails closed, workflows refused before any hold, the API's answer, replay, rollback keeping the record, and the 0075
  replay hazard), the lab's isolation suite (`sec_rights_acknowledgement_0174.py`), `tests/test_rights_acknowledgement_migration.py`
  (each body is the earlier one plus inserted 0174 blocks only; pins), `command-center/tests/rights-acknowledgement*.test.ts(x)`.

## Owner analytics hub: owner-only reads of money, people, activity and jobs (0182)

0182 (`0182_owner_analytics.sql`) gives the platform owner's analytics hub (`/{channel}/owner-analytics`, `docs/OWNER_ANALYTICS.md`)
its reads. Read-only over existing tables, plus one log of its own.

- **Who.** Every function checks `owner_analytics_is_owner()` (signed in and `platform_role() = 'owner'`) before it reads or looks
  at an argument, and raises 42501 otherwise — a platform **admin** is refused too. Execute is granted to `authenticated` only.
  `owner_analytics_sales_all()` is internal (no API role may execute it).
- **Money.** `owner_analytics_money(from, to)`: each credited sale (one row per payment, a webhook retry is not a second sale),
  classified plan / pack / api_topup / unknown, initial / renewal when the record says (else null), and each refund and dispute.
  Amounts as the provider reported them; null stays null. `fee_minor` is always null: no webhook stores a provider fee. The
  operator's own workspace is returned with `internal = true`.
- **People.** `owner_analytics_people()`: opaque ids only (no e-mail, no name), signup, last sign-in, locale, acquisition when
  recorded (referral / invite), the funnel milestones and the first plan.
- **Activity and jobs.** `owner_analytics_activity(from, to)` (distinct Tashkent day × person, ≤ 400 days, the roster left out) and
  `owner_analytics_jobs(from, to)` (grouped counts, credits charged, timed seconds).
- **Export log.** `owner_analytics_exports` (RLS on, no policy, no grant), written only by `owner_analytics_record_export()` with the
  actor pinned to `auth.uid()`, read by `owner_analytics_export_log()`. The export route records before it builds the file.
- **Internal / test workspaces.** `owner_analytics_internal_orgs` (closed like the log), set by the owner through
  `owner_analytics_set_internal(org, on, reason)` and listed by `owner_analytics_internal_list()`. Internal = the default workspace,
  any workspace owned by a roster account, and any flagged one. Every function returns `internal`; the hub leaves those rows out
  by default, with a toggle. No workspace id is written in the migration. Granted credits are never revenue.
- **Without it.** The hub says it needs 0182 and shows no figure; exports are refused.
- Lab: `tests/security/sec_owner_analytics_0182.py`, `tests/security/test_sec_owner_analytics.py`. Rollback:
  `docs/sql/rollback_0182_owner_analytics.sql`.

## Trend templates: ready formats for the Trends gallery (0183)

0183 (`0183_creative_templates.sql`) gives the Trends gallery (`/{channel}/trends`, `GET /api/templates`) its table: ready
short-form formats that open Create prefilled. Additive: one table, its updated_at trigger, and a ten-row seed.

- **Who.** RLS on. `anon` and `authenticated` may read **published** rows only. No API role may insert, update or delete; the
  service key and the SQL editor write.
- **What a row is.** A format, not content: a prompt with `{placeholders}`, the model it was written for (`model_id`, a foreign key
  to `model_registry`), the shape (16:9 / 9:16 / 1:1), the length for video (5 or 10 s), a quality tier, director notes, and
  titles and descriptions in en / ru / uz. A slug must contain a hyphen, so it can never be read as a Studio starter id (those
  use underscores and share `?template=`).
- **Availability is never stored.** Whether the template's model is on sale is asked of `sellable_models()` on every request. The
  API returns `model_status` available / unavailable / unknown, and never names a substitute model.
- **Media is not in the database.** Preview clips and posters are app files under `command-center/public/templates/<slug>/`,
  listed in `command-center/lib/templates/media-manifest.json`. A test holds the manifest and the files in step.
- **Seed.** Ten formats on models on sale when it was written (the MiniMax H3 family, Ideogram). A row is inserted only when its
  model exists in `model_registry`, and `on conflict (slug) do nothing`, so re-applying never undoes an edit.
- **Without it.** `/api/templates` answers 503 `not_enabled` and the Trends page says Trends are not available here.
- Lab: `tests/security/sec_creative_templates_0183.py`, `tests/security/test_sec_creative_templates.py`,
  `tests/security/test_sec_breach_creative_templates.py`. Rollback: `docs/sql/rollback_0183_creative_templates.sql`.

## Owner analytics: costs, balances and the owner's monthly costs (0184)

0184 (`0184_owner_costs.sql`) gives the hub's Costs & profit tab its reads and the owner's two inputs. No value is in the file.

- **Provider spend.** `owner_analytics_provider_spend(from, to)`: `creative_job_costs` (0037) and the pipeline's `video_costs` (0002)
  by Tashkent day, provider and model — rows, the sum of the priced ones, and how many were unpriced (unknown, never 0). Internal
  workspaces (0182) and the pipeline are flagged internal.
- **Balances.** `owner_analytics_balances()`: the newest `provider_balances` row per provider and metric, with `source` (api /
  manual). `owner_analytics_balance_enter()` stores an owner-typed balance in its own closed table `owner_manual_balances`, never in
  `provider_balances` (the operator bot's stale/zero alerts and Billing read that as the provider's own word). Nothing calls a provider.
- **Writes** go through `owner_costs_write_guard()`: owner, 0107's second factor, and 60 writes per 10 minutes (`take_web_rate`).
- **Monthly costs.** `owner_cost_entries` (closed), written by `owner_analytics_cost_add / _delete`, read by `owner_analytics_costs`.
- **Provider runway.** `owner_analytics_model_activity(from, to)` (at most 200 days): creative jobs per model and unit — counts by
  outcome, units, first and last time, and how the newest job ended (status, error_code). Every workspace counts: all spend the
  provider's balance. Counts only, no amount and no customer.
- **Who.** Owner only (0182's gate), writes also need 0107's second factor when it is on (NS401). Granted to `authenticated` only.
- Lab: `tests/security/sec_owner_costs_0184.py`, `tests/security/test_sec_owner_costs.py`. Rollback: `docs/sql/rollback_0184_owner_costs.sql`.

- Lab: `tests/security/sec_owner_costs_0184.py`, `tests/security/test_sec_owner_costs.py`. Rollback: `docs/sql/rollback_0184_owner_costs.sql`.

## Owner analytics: frozen exchange rates for the income register (0185)

0185 (`0185_owner_fx_rates.sql`) stores the exchange rates the owner freezes for the hub's Tax register. No rate is in the file,
and nothing fetches one.

- **Table.** `owner_fx_rates`: one rate per day and currency (UZS per unit, numeric(18,4)), the source the owner names, who
  entered it and when. RLS on, no policy, closed to every API role.
- **Functions.** `owner_analytics_fx_set(day, currency, uzs, source)` (setting it again replaces it), `owner_analytics_fx_delete`,
  `owner_analytics_fx_rates(from, to)` (at most 1100 days). Writes go through 0183's `owner_costs_write_guard()` (owner, 0107's
  second factor, the shared rate limit). Granted to `authenticated` only.
- **Without it** the register lists payments in their own currency and every UZS cell reads "no rate stored".
- **Requires** 0182 and 0184. Lab: `tests/security/sec_owner_fx_0185.py`, `test_sec_owner_fx.py`, `test_sec_breach_owner_fx.py`.
- **Rollback:** `docs/sql/rollback_0185_owner_fx_rates.sql`. It drops the table and its functions: every frozen rate is lost
  (files already exported keep the rate they were made with).

## Trend templates, second set: the "viral" category (0186)

0186 (`0186_viral_templates.sql`) widens `creative_templates.category` to include `'viral'` and seeds ten more formats: seven
"Trending effects" (treasure strike, object morph, giant-hand makeover, scale shock, water revival, language-duo podcast and its
cover), a holiday sale ad and a sale story poster (business), and a 3D family moment (story). Additive: the CHECK is dropped and
re-added with every old value kept; no table, function or grant changes.

- **Why these.** Chosen from an outlier search on 2026-11-20 (AI-made Reels/TikTok posts far above their own account's median)
  and a language-duo series the owner collected. Formats only: nothing from those posts is copied, and no view count is shown.
- **Seed rules as 0183.** A row lands only if its model is in `model_registry`; `on conflict (slug) do nothing`, so re-applying
  never undoes an owner's edit. Media are static files under `public/templates/<slug>/`, listed in the manifest.
- Rollback: `docs/sql/rollback_0186_viral_templates.sql` (deletes the ten seed rows, restores the four-value CHECK).

## Rights acknowledgement asks about every file a job sends (0187)

`0187_rights_acknowledgement_inputs.sql` closes the four latent paths Breach found past 0174 (tests/security/test_sec_breach_rights_ack_bypass.py,
test_sec_breach_rights_ack_films.py): an auto-mode failover onto a model that requires an acknowledgement, a style kit's reference
pictures, an @character's pictures, and a film clip's uploaded first frame.

- **Change.** `rights_acknowledgement_missing` keeps 0174's signature and now asks about every file the job sends
  (`rights_acknowledgement_subjects`: source, end, the kit's live pictures, every mentioned character's live pictures, with the worker's
  own @name rule). `reroute_creative_job` (0088's body, one marked hunk) skips a candidate the requester has not acknowledged for.
  `start_film` (0171's body, one marked hunk) returns `acknowledgement_required` after the re-pricing and before the hold
  (`film_acknowledgement_missing`, which also reads each scene's visual prompt for @names); the Timeline names the remedy.
  `workflow_quote_steps` (0174's body, one marked hunk) refuses a step that sends kit or character pictures, before any hold.
  `creative_job_style` (0048's body, one marked hunk) asks again when the job runs, so a picture added to a kit or character
  after the job was created is never handed out unacknowledged. Three new internal functions; no API role may call them.
- **Not changed.** Which models require an acknowledgement, every availability and price, quote_film (a quote holds nothing).
  Latent today: no model on sale requires one.
- **Replay.** Replays onto itself. Re-running 0174 after it fails loudly; re-running 0088, 0171 or 0048 after it silently restores the old
  body: apply 0187 again and run its Verify query.
- **Undo.** `docs/sql/rollback_0187_rights_acknowledgement_inputs.sql` (owner-applied): the five earlier bodies back verbatim, the
  three new functions dropped. Roll 0187 back BEFORE 0174: rollback_0174 now refuses while 0187 is on.

## Recraft: the web and our MCP connector, never the public API (0188)

`0188_recraft_web_mcp.sql` adds a third registry exposure, `web_mcp`. A model with it is sold on the web and to the `mcp` surface (our own
signed-in connector), never to `api` (the public developer API). Recraft V4.1 and V4.1 Flash carry it after Recraft support's written
confirmation (email of 2026-11-17/18), which covers the web studio and our MCP connector but not /api/v1.

- **Change.** `sellable_models` (0125's body): only `any` opens `api`; `web_mcp` opens `mcp`; any other value opens the web alone (fail
  closed). `api_creative_model_ok` (0124's body): the "temporarily off" word is for `any` models only.
- **Beta is guarded.** Both Recraft rows go hidden → beta only where the verified probe is a passed run of the vendor model the registry
  names now (Flash is `recraftv4_1_flash_v2`). Without one nothing changes: dispatch `.github/workflows/probe_models.yml` with the model
  id, then apply 0188 again. A sale still needs the owner's `credit_prices` rows.
- **Not yet reachable over MCP.** No MCP tool asks for the `mcp` surface until the connector's creative tools land (a separate PR).
- **Undo.** `docs/sql/rollback_0188_recraft_web_mcp.sql`: refuses while a model is `web_mcp` (it would reopen the API).

## get_job_status names the video; list_videos lists newest first (0189)

`0189_job_video_and_list_order.sql`: through the MCP connector a new video could not be found. `get_job_status` named no video, and
`api_list_videos` (0042) sorted held runs (no `published_at`) by id after every upload, while a video made through MCP is held for review.

- **Change.** `render_jobs.result_slug` (written once by the queue worker, from the run's result file, when the run succeeded; a
  browser's insert must leave it empty). `api_get_job` and `oauth_get_job` (0111's bodies, one marked hunk each) answer `video_id`: that
  slug's video in the job's own channel (an uploaded row before a held one), NULL until recorded. `api_list_videos` (0042's body) orders
  by `video_listed_at(published_at, held_at)` desc: an unreadable `published_at` is unknown and sorts last, never a guessed date.
- **Not changed.** Who may see a job or a video, every price, hold and publish rule.
- **Undo.** `docs/sql/rollback_0189_job_video_and_list_order.sql` (owner-applied): the three earlier bodies back verbatim; the
  `result_slug` column and its values stay.

## The probe log names a refused plan (0190)

0190 (`0190_probe_error_plan_required.sql`) is **live on apply**: it replaces ONE check constraint, `model_probe_runs_error_code_check`
(0035 / 0143), with the same rule plus one word, `plan_required`. No table, column, row, function or grant changes.

- **Why.** A real ElevenLabs call on 2026-11-20 was answered HTTP 402 `paid_plan_required`: a library voice on a free plan. 402 is also
  ElevenLabs' status for an empty balance, which needs the opposite fix, so the adapter now reads ElevenLabs' own code and raises
  `E_PLAN_REQUIRED` (`modules/capabilities/base.py` `ERROR_CODES`); `record_model_probe` inserts the code as given, so without 0190 such a
  probe could not be recorded. Job rows (0036) already take any `^[a-z0-9_]{1,64}$` word; the Studio shows it as its own reason, not
  "busy". The router's failover (0075 / 0088) does not list it: a plan refusal is never failed over.
- **Safe to apply.** The new rule accepts every row the old one did. Apply as ONE transaction (`set local lock_timeout`); the last block
  compares the whole constraint, as Postgres prints it back, to the expected rule.
- **Undo.** `docs/sql/rollback_0190_probe_error_plan_required.sql` (owner-applied): refuses while the log holds a `plan_required` row, then
  puts 0143's words back and checks the printed rule the same way.
- **Numbering.** 0190, assigned at merge after 0189; 0175-0181 are left to the work that reserved them. The numbering tests of 0127, 0131 and 0133 list it as
  reviewed (it names nothing they pin).
- **Tests.** `tests/test_probe_error_plan_required_migration.py`; `tests/test_probe_error_vendor_tool_migration.py` now pins the newest
  check, not 0143, to `ERROR_CODES`.

## The Studio for a connected assistant (0191)

0191 (`0191_mcp_oauth_creative.sql`) lets an AI assistant the person connected with OAuth (0093) quote and start Studio generations,
charged to the workspace's credits exactly as in the Studio, with every model off until its vendor's terms allow it (the first on: Recraft V4.1 / Flash). The consent page offers Studio
spending as its own unticked choice; a connection gets it only when the person ticks it.

- **A new permission, `studio:create`.** Shown on the consent screen on its own line. Not folded into `videos:create`: a person who
  allowed "make videos" agreed to nothing else, so no existing connection gains generation. `oauth_scopes_supported()` lists it and
  `oauth_grants_scopes_check` accepts 1-4 of the four (the one constraint change; every existing row passes it).
- **A per-model switch, off.** `spec.mcp_oauth_exposure` (the registry file's `mcp_oauth_exposure`): only JSON `true` turns a model on;
  separate from `api_exposure` (a developer's own code). `oauth_creative_model_state(capability, model)` is the one judgement the
  list, the quote and the create share: on sale and allowed for our connector (`sellable_models(cap, 'mcp')`, 0188), one of the
  API's capabilities (never captions), switched on, no `blocked_countries`, no rights acknowledgement (0174's spec key or column;
  0187's per-file check runs again inside `create_creative_job`). The list returns only a model's shape (output, sizes, ratios,
  durations, inputs, prompt length), never its pricing or terms notes. `tests/test_mcp_oauth_creative_migration.py` lists the models that may be on (Recraft V4.1 / Flash, written permission of 2026-11-17/18).
- **Records.** `oauth_creative_quotes` (one connection's price for one exact generation, 15 minutes, used once), `oauth_creative_jobs`
  (which connection started which generation from which quote, under which key, holding what), `oauth_creative_rate_counters` (30
  quotes and 10 creates a minute per connection, on top of 120 requests). RLS on, no policy, no API role.
- **Five doors** (anon, a token hash), each opening with `oauth_ctx` directly so an API key's hash is unknown to them:
  `oauth_creative_models`, `oauth_media_list`, `oauth_creative_quote`, `oauth_creative_create(token, quote_id, idem_key)`,
  `oauth_creative_get`. Create takes nothing but the quote and the key: it refuses another connection's quote (404, same as unknown),
  a used one, an expired one and a price that is not exactly the quote (`price_changed`), checks the connection's monthly limit under
  the credit account's lock, then calls `create_creative_job` (not replaced) with the quote as `max_credits`, and refuses (undoing the
  hold) if the job holds anything else. It writes an `api_requests` row and an `app_audit_log` `creative.generate` row (via `mcp_oauth`).
- **Replaces** 0093's `oauth_scopes_supported` (`b1cdcf01…` → `3ef7e315…`), `oauth_endpoint_scope` (`ade9dedd…` → `39be9da5…`, five
  endpoints added, still no `else`) and `oauth_grant_month_credits` (`6329f5ed…` → `6d345abd…`, generations' holds counted), and
  0147's `oauth_begin_authorization` (`1d77b561…` → `c385018b…`: a client that asks for nothing still gets 0093's three).
  Adds `oauth_drop_requested_scope`: an unticked Studio choice takes `studio:create` off the request; a request that holds
  nothing else is refused by name (`studio_only`, the consent page says: tick it or deny). Ends with `notify pgrst`.
- **Without it.** The five MCP tools answer 503 `api_unavailable` naming 0191; nothing else changes.
- **Number.** 0191, assigned at merge after 0190. Needs 0038, 0062, 0075, 0093, 0124, 0147, 0174 and 0188.
- **Undo.** `docs/sql/rollback_0191_mcp_oauth_creative.sql` (owner-applied): refuses while a connection holds `studio:create`, drops
  the doors, puts 0093's three bodies, 0147's begin and the check back, deletes pending requests that hold `studio:create`
  (minutes-long), keeps the record tables.
- **Tests.** `tests/test_mcp_oauth_creative_migration.py`, `tests/security/test_sec_mcp_oauth_creative.py` (a real PostgreSQL),
  `command-center/tests/mcp-oauth-creative.test.ts` (the MCP layer).
- **Order.** Applied after 0188, whose `mcp` surface (`web_mcp` or `any` only) is the one it asks `sellable_models` about.
