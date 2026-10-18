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
