# Supabase setup — the Command Center data backbone

The Nightshift bot runs fully local by default: its state lives in
`history/chronos.db`, which on the scheduled GitHub Actions runners exists only
for the life of one job. To power the real-time **Command Center** (the separate
Next.js app) with **real** data, the bot mirrors that state into a
hosted Supabase Postgres project, and the dashboard reads (and live-subscribes
to) it.

Until you complete the steps below, everything keeps working — the mirror is a
**no-op** and nothing is exposed. This is the one manual, credential-bearing
step that only you can do.

## 1. Create the project
1. Sign in at <https://supabase.com> and create a new project (free tier is
   fine to start). Pick a region close to you.
2. Wait for it to finish provisioning.

## 2. Apply the schema
1. In the project, open **SQL Editor → New query**.
2. Paste the entire contents of [`supabase/schema.sql`](../supabase/schema.sql)
   and click **Run**. It is idempotent — safe to re-run after updates.
   This creates the tables, enables Realtime on the activity/score tables, and
   turns on Row Level Security so the data is readable only by a logged-in user.

## 3. Collect the keys
In **Project Settings → API**, copy:

| Value | Where it goes | Notes |
| --- | --- | --- |
| **Project URL** (`https://xxxx.supabase.co`) | `SUPABASE_URL` (bot) **and** the Command Center app | public |
| **service_role key** | `SUPABASE_SERVICE_KEY` (bot only) | **secret — server-side only, never ship to the browser.** Bypasses RLS to write. |
| **anon key** | the Command Center app only | public; RLS keeps it read-only and login-gated |

## 4. Give the bot the secrets
In the `nightshift-ai-studio` GitHub repo → **Settings → Secrets and variables →
Actions**, add:

- `SUPABASE_URL` = the Project URL
- `SUPABASE_SERVICE_KEY` = the service_role key

The daily intelligence poll (`.github/workflows/intelligence_poll.yml`) already
reads these; once set, its final pass mirrors state to Supabase automatically.
No code change needed.

## 5. Verify
- Trigger the **Intelligence Poll** workflow manually (Actions → Intelligence
  Poll → Run workflow). With the secrets set and at least one published video in
  the DB, the run log ends with `Supabase mirror complete: {...}`.
- In Supabase **Table Editor**, confirm rows appear in `system_events`,
  `videos`, `topic_performance`, etc.
- Locally you can dry-run the mirror without CI:
  ```bash
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python tools/run_intelligence_poll.py
  ```

## What gets mirrored
`modules/supabase_sync.py` upserts (idempotent — safe to re-run):

- `videos`, `metrics_snapshots` (latest per video), `competitor_snapshots`,
  `trending_snapshots`, `feedback_signals`, `topic_performance`
- `system_events` (the activity feed; upserted on a synthetic `event_key` so
  re-syncs never duplicate)
- `video_costs` (append-only; each row carries a deterministic `row_key` and is
  sent with `on_conflict=row_key` + ignore-duplicates, so the nightly re-send of
  the whole history adds nothing; see "Migration 0106" below)

## Security
- RLS is **on** for every table with **no public read policy**, so the anon key
  alone reads nothing. The Command Center must authenticate a Supabase user.
- The bot writes with the service-role key (server-side, in GitHub Actions
  secrets — never in the browser bundle).
- The event stream never contains secrets: `modules/event_log.py` redacts
  credential-bearing metadata keys before they are ever stored.


## Operational tables (Phase 4, step 1)

`supabase/schema.sql` also creates two read-only observability tables:

- `content_queue` — ContentPlanner's queued topics.
- `pipeline_runs` — PipelineStateMachine's runs and the `human_approved` audit
  flag.

They are mirrored from the bot's `history/` state by the intelligence poll
(`SupabaseSync.mirror_planner_and_runs()`), carry the same authenticated-read
RLS as every other table, and are **not** read back into the pipeline —
publishing behaviour is unchanged.

**Re-run `supabase/schema.sql` in the Supabase SQL editor** after updating, or
the Command Center's Autonomy page will report that the tables were not found.


## Multi-channel tables (Phase 5)

`supabase/migrations/0001_multi_channel.sql` adds three tables and a
`channel_id` column to the existing ones:

- `channels` — channel configuration, written by the Command Center's Channels
  page (the one table with an authenticated insert/update policy — no delete,
  and no data table gains one).
- `channel_credentials` — credential **health only**: connected / not_connected
  / expired / error, plus expiry and last-verified. There is no column that can
  hold a token, and there never will be.
- `channel_topic_performance` — learned scores keyed on `(channel_id, topic)`,
  so two channels never collide on the same topic string.

The migration is additive: no drop, no rename, no delete. Existing rows backfill
to the `default` channel in the same `ADD COLUMN ... NOT NULL DEFAULT 'default'`
statement. A fresh project needs only `supabase/schema.sql`, which inlines the
same statements. See `docs/MULTI_CHANNEL.md` for what is scoped per channel and
why `topic_performance` was deliberately left untouched.

**Apply the migration in the Supabase SQL editor**, or the Command Center's
Channels page will report that the tables were not found and the app will keep
running as the single default channel.

## Migration 0002 — measurement

`supabase/migrations/0002_measurement.sql` adds:

- `video_costs` — one row per measured quantity a video consumed. `estimated_usd`
  is NULL unless the operator configured a rate (`CHRONOS_PRICE_*`); it is
  append-only, because a run that was retried cost real money twice and an
  upsert would collapse that into one charge.
- `retention_points` — one row per measured point of a video's retention curve.
- `videos.thumbnail_variant`, `videos.title_variant` — which A/B arm shipped.
- `metrics_snapshots.impressions`, `metrics_snapshots.impression_ctr` —
  click-through as YouTube reports it.

Additive like 0001, and every added column is **nullable with no default**:
"not measured" and "measured as zero" are different facts, and this schema has
to be able to tell them apart. RLS posture is unchanged — both new tables are
RLS-on with an authenticated-read policy and no write policy.

See `docs/MEASUREMENT.md` for what reads these tables and for the pre-publish
gate, which is the one Phase 6 change that alters publishing behaviour.

## Migration 0106 — idempotent video_costs mirror

`supabase/migrations/0106_video_costs_idempotent.sql` closes a duplication bug
before it could cost anything: the nightly mirror used to re-insert every local
`video_costs` row on each run (the table has no natural key), so a cost would
have been stored once per night. It adds, and nothing else:

- `video_costs.row_key` — nullable text, no default; rows from before the
  migration keep NULL and are never touched.
- `video_costs_row_key_uidx` — a **plain** UNIQUE index on `(row_key)`. Not a
  partial index: PostgREST's `on_conflict=row_key` cannot carry the `WHERE` that
  Postgres needs to match a partial unique index, and a unique index already
  lets any number of NULLs coexist.
- `owner_provider_spend(p_days)` — platform owner/admin only (SECURITY DEFINER,
  checks `is_platform_admin()` first, `authenticated` may execute, `anon` and
  `service_role` may not): provider spend per UTC day from `video_costs` and
  `creative_job_costs`, 1 to 180 days. Providers are named as
  `command-center/lib/billing.ts` names them (`elevenlabs` for `tts_characters`,
  `gemini`, the clip/image provider from the `broll:<id>` / `image:<id>` stage);
  a row with no real provider (render, pexels, upload, vision, other clip stages)
  is reported under a pseudo name, never as a bill. A total is NULL, never 0,
  when any row of it is unpriced. Nothing reads it yet; a follow-up moves Billing
  off raw rows.

The mirror computes `row_key = 'v1:' + sha256(channel_id, video_id, slug, unit,
stage, recorded_at, quantity, occurrence)` (`video_cost_row_key` in
`modules/supabase_sync.py`; `occurrence` tells two truly identical rows of one
flush apart). If the column is missing (the migration is not applied yet) the
write is refused, the mirror **skips `video_costs` for that run and logs why**
(a missing column or index is told apart from a timeout or server error in the
warning); it does not fall back to a plain insert, because that is the old
duplicating behaviour. Rows go in chunks of 2000; ignore-duplicates makes a
retried chunk harmless. The local database keeps every row, so the first run after the
migration sends the whole history once.

If `video_costs` was ever filled before this migration, run the owner-applied
`docs/sql/dedupe-video-costs.sql` once (preview first; it ends in ROLLBACK until
you change it). The table was empty when 0106 was written.

## Migration 0003 — Shorts

`supabase/migrations/0003_shorts.sql` adds two columns to `videos`:

- `video_format` — `'long'` or `'short'`, defaulted to `'long'` because every
  row that exists before the migration runs **is** a long video.
- `parent_video_id` — for a Short, the long video it was cut from.

A Short is its own YouTube video with its own id and its own metrics, so it is
its own row; these columns are what keep it from reading as a second long video.
Additive: two columns, no drop, no rename, no delete. See `docs/MEASUREMENT.md`
for why Shorts are off unless a channel turns them on.

## Storage policies: migrations only, never the dashboard

Policies on `storage.objects` are permissive and **add up**: one broad `select` policy overrides every
narrow one beside it. So they are created by a migration, reviewed like any other SQL, and **not** by
the dashboard's "New policy" button (it names them `<name> <random>_0` and offers a template that tests
only the bucket).

That happened once. The live project held a second read policy on the private `previews` bucket,
`previews_read 1dyqf8r_0` (`select to authenticated using (bucket_id = 'previews')`), which no migration
created: any signed-in user could list, read and sign every customer's review render
(`<channel_id>/<video_id>.mp4`). The bucket held no objects at the time, so nothing had leaked.
Migration **0098** drops it by name and re-asserts the tenant-scoped `previews_read` from 0018.
`voice-previews` (shared on purpose), `avatars` and `publish-staging` are not touched.

It also runs a **best-effort** clean-up: any other permissive `select`/`all` policy that names the
`previews` bucket (the literal, or a `'{previews,...}'` array) without calling
`accessible_channel_ids()`/`is_platform_admin()` is dropped, with a NOTICE. This is a heuristic for
the known drift and common dashboard-style variants, **not a catch-all**, and restrictive policies
are never dropped. Known survivors (pinned by tests in `tests/security/test_sec_previews_policy.py`):
`bucket_id <> 'avatars'`, `like 'prev%'`, `~ '^prev'`, `'prev' || 'iews'`, a sub-select on
`storage.buckets`, a policy with no bucket test, and a broad policy that also contains a scoping
function name (`bucket_id = 'previews' or ... accessible_channel_ids(...)`, `... and
(is_platform_admin() or true)`). So the check that counts after applying is the allowlist query below.

**The live project needs 0098 applied; it is not a repo-only fix.** The security lab applies it to a
scratch database and attacks the result, but CI never connects to the live project. Apply the whole
file in one go (the `drop` and `create` of `previews_read` belong together: the drop alone leaves
previews unreadable for everyone until the create runs, which is safe but breaks the review panel),
then verify read-only with these queries (all are at the bottom of the migration):

```sql
-- 1. THE CHECK THAT COUNTS: strict allowlist. Expected: 0 rows. A row is a policy this repo did not create.
select policyname, cmd, roles::text, permissive, qual as using_expr, with_check as check_expr
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
   and policyname not in ('avatars_delete_own','avatars_insert_own','avatars_select_own',
                          'avatars_update_own','previews_read','voice_previews_read');
-- 2. all policies, USING and WITH CHECK separately. Expected: exactly those six.
select policyname, cmd, roles::text, permissive, qual as using_expr, with_check as check_expr
  from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname;
-- 3. what the clean-up looks for (heuristic). Expected: 0 rows; passing it does not prove there is no leak.
-- 4. SELECT/ALL policies that name no bucket at all. Expected: 0 rows.
-- 5. select tablename, policyname, cmd, roles::text, qual from pg_policies
--     where schemaname = 'storage' and tablename <> 'objects';   -- expected 0 rows or known ones
-- 6. select id, public from storage.buckets where id = 'previews';   -- public = false; ZERO rows = no such bucket row
```

Queries 3 to 6 are written out in the migration. Query 5 was not checked against a real project (the
lab does not model the real storage schema). Rolling back means re-running the scoped `previews_read`
drop and create together; never recreate a broad one. If a row shows up in query 1, read it with query
2 and remove it by a migration, not by hand.

## Deleting an account: the profile photo

A person's profile photo is a Storage object, `avatars/<uid>/avatar.jpg` (migration 0097), and it
is **not** removed when the account is (there is no row to cascade from; the version marker lives in
the user's auth metadata). When an account is deleted, remove that object too: with the Storage API
and the service key, e.g. `DELETE /storage/v1/object/avatars/<uid>/avatar.jpg` (or `remove()` in
supabase-js), **never** with `delete from storage.objects` in SQL. A row deleted in SQL leaves the file
behind in the object store, so the photo would stay on disk with nothing pointing at it.
