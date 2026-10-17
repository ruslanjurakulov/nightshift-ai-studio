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
