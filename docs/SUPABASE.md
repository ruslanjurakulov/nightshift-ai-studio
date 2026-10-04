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

## Migration 0003 — Shorts

`supabase/migrations/0003_shorts.sql` adds two columns to `videos`:

- `video_format` — `'long'` or `'short'`, defaulted to `'long'` because every
  row that exists before the migration runs **is** a long video.
- `parent_video_id` — for a Short, the long video it was cut from.

A Short is its own YouTube video with its own id and its own metrics, so it is
its own row; these columns are what keep it from reading as a second long video.
Additive: two columns, no drop, no rename, no delete. See `docs/MEASUREMENT.md`
for why Shorts are off unless a channel turns them on.
