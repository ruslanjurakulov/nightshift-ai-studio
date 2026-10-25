# Results dashboard (dark, `NIGHTSHIFT_RESULTS_DASHBOARD`, default off)

The owner's idea: every user sees, per connected channel and platform, how their published videos are doing. This is
phase 1: **YouTube results where a channel is connected, plus the workspace's own publish history, in one page**. The other
platforms appear as honest cards with no numbers.

Nothing here is switched on. The page `/{channel}/analytics/results` and the route `/api/results` answer the 404 until the owner sets
`NIGHTSHIFT_RESULTS_DASHBOARD=on` (also `1`, `true`, `yes`) on the Command Center's server (repository variable of the same
name, mapped in `deploy_web.yml`, listed in `deploy/.env.web.example`). There is **no worker side and no migration**.

## It is read only

The page never publishes, never spends credits and never calls a platform. It reads what is already stored:

| Shown | Read from | Written by |
| :-- | :-- | :-- |
| Channels, connected or not | `channels` (+ `channel_token_status()`, the account panel's rule) | the Channels page |
| Videos published in the period | `videos` (`published_at` set; a held run has none) | the pipeline |
| Views, watch time, likes, comments, average view duration | `metrics_snapshots` | the daily poll (`modules/intelligence_poller.py`) |
| Publish history | `videos` (the pipeline's own upload) and `publish_requests` (cross-posts, 0029) | the pipeline, the publish worker |
| Instagram / TikTok connected? | `social_accounts` (0028) | the connect flow |

All reads use the signed-in member's own session (anon key + cookie). No service key, no RPC, no insert, no update.
`tests/results-dashboard-routes.test.ts` fails if the route or the loader gains a write, an RPC, a service key or a `fetch`.

## What a number means (read this before trusting one)

A `metrics_snapshots` row is YouTube's figure for a **two-day window** ("yesterday through today") that the daily poll read for
a recently published video. It is not a lifetime total, and two daily readings of one video overlap by a day. So:

- the dashboard **never adds readings of one video together**. Per video it takes the **latest** reading and prints its date and
  how many days after publishing it was taken;
- a KPI adds those latest readings across videos and prints **how many videos it covers** ("1 of 2 videos measured");
- every figure tile is labelled "(latest readings)", and when the list is cut to the newest 200 videos the tiles say so;
- a video with no reading is **"Not measured"**, never `0`; an average is taken over the videos that have both of its parts and is
  weighted by views; a sum over no known value is `null`;
- "as of" is the date of the newest reading, with its age; older than 3 days it says so and says that later views are not included.

### What does not count as a reading

The poller (`modules/intelligence_poller.py`) stores **NULL** for every metric YouTube did not return: `video_performance` gives
`{}` for a video it has no row for yet, and that is now a row of NULLs, not of zeros. A 0 that YouTube did send stays 0. (The
`metrics_snapshots` columns were always nullable, so this needed no migration.) A second poll of the same day that returns
nothing does not erase what the first one measured: the **local database** (`chronos.db`) keeps the earlier value under a NULL
(`StateStore.record_metrics_snapshot`), and the Supabase mirror copies local state. The mirror's own upsert would overwrite with
NULL if `chronos.db` were lost and re-polled (the history lives in an Actions cache), so the guarantee is the local one.

A video YouTube returned **nothing at all** for (no metric and no click-through) gets **no row** since this change: an all-NULL row
dated today is the newest snapshot, and every Python reader takes the newest. `StateStore.latest_metrics` also skips any row whose
figures are all NULL (rows the first version wrote), and `metrics_history` keeps them. The dashboard then shows such a video as
"Not measured" without the "No data yet" note, which only a stored empty row can produce.

**Who now treats NULL as unknown (a decision change, since the first version of this change):** `quota_allocator`,
`publish_timing`, `sponsorship`, `repackage`, `niche_rpm`, `hook_ab`, `ab_testing` and `title_formulas` skip a NULL figure
instead of counting a 0 (their helpers return None for a missing value), so a video the poll could not measure no longer
drags a channel's weight or a variant's mean down. `feedback_engine` and `performance_analyzer` still read a NULL `views` as 0
(`int(metrics.get("views") or 0)`); they are unchanged here and are a follow-up.

Before that change the poller wrote `int(metrics.get("views", 0) or 0)`, a **full row of zeros**, and those rows are still in
the table, so the dashboard keeps both rules (`lib/resultsDashboard/aggregate.ts`, `buildVideoResults`):

1. A snapshot whose views, likes, comments, watch minutes and average duration are **all NULL or all exactly 0** is treated as
   "no data came back". It is skipped; the video falls back to its newest non-empty reading, or is "Not measured" (row text "No
   data yet", counted in the note under the figures) when it has none. A snapshot with any other figure is a reading; its NULL
   figures stay "not measured".
2. An average duration of exactly 0 next to views > 0 is **unknown** (null), so it cannot pull the views-weighted average down.
3. A snapshot dated **before the video's publish day** cannot be a reading of that video and is excluded (not shown, not counted).

The all-zero rule cannot be retired while legacy rows exist: it also hides a genuinely measured all-zero row, which cannot be told
from a legacy empty one. Retiring it would need a backfill (a migration of its own), not part of this change.

**Known limit, not hidden:** the poll as scheduled (`poll_own_channel_metrics()` with its default `days=1`) reads a video only
around the day it is published. So by default most readings are early-life readings, not current ones. The dashboard says "day N
after publishing" for every reading and the staleness line explains it. The owner can widen the poll (next section); until then
nothing changes.

## Widening the poll: `NIGHTSHIFT_METRICS_POLL_DAYS` (repository variable, empty = off)

Set the repository variable `NIGHTSHIFT_METRICS_POLL_DAYS` (Settings -> Secrets and variables -> Actions -> Variables) to a whole
number of days, **1 to 90**, and the daily poll (`.github/workflows/intelligence_poll.yml`, 20:00 UTC) re-reads every video
published in the last N days instead of only those published since yesterday. Each re-read is the same short window
("yesterday through today") written as that day's snapshot, so a video keeps getting a fresh reading for N days after it goes out and
the dashboard's "day N after publishing" becomes a current reading instead of a day-0 one.

**The decision engines do not change when you turn this on.** A snapshot is YouTube's two-day window. `feedback_engine`,
`performance_analyzer`, `quota_allocator` and `publish_timing` divide `views` by the days since publishing as if it were a
lifetime total, which is only right for a reading taken in a video's first days (the same 100 views read 100.0 a day for a
1-day-old video and 1.67 for a 60-day-old one). So the widened poll files its readings of videos **older than 3 days**
(`EARLY_LIFE_DAYS`) in a separate local table, `metrics_snapshots_late`: `StateStore.latest_metrics` and `metrics_history` (what
every reader uses) never see it, and the retention curve is not read for those videos (a late curve would replace the early one
`hook_ab` judges, and is about 100 stored points a day). `StateStore.newest_metrics` reads both tables and is what the Supabase
mirror copies, so the dashboard shows the late readings and nothing else changes. Turning the variable off again leaves those rows
where they are, still invisible to the readers. `tests/test_widened_poll_decisions.py` runs the analyzers with and without
widened readings and asserts the same answers. The late table is local to `chronos.db` (created on open, no migration).

- **Empty or unset: exactly today's behaviour.** The poll calls `poll_own_channel_metrics()` with no arguments, as before.
- **Anything that is not a whole number from 1 to 90** (`0`, `91`, `365`, `7.5`, `abc`) is **ignored with a warning in the poll log
  that names the variable**. It is not clamped: a typo must not widen a quota-bound job.
- Only the poll reads it (the queue worker never polls analytics), so it is mapped in `intelligence_poll.yml` only, like
  `CHRONOS_ENABLE_REVENUE` and `CHRONOS_DAILY_UPLOAD_SLOTS`, and not in `deploy/.env.worker.example` / `WORKERENV_`.
- Other channels follow the same value: `tools/run_intelligence_poll.py` passes it to every channel's poller.

### Quota math

Per video polled, the poll makes **3 YouTube Analytics `reports.query` calls**: core metrics (`video_performance`), click-through
(`video_ctr`) and the retention curve (`video_retention`). So per channel, per run:

    calls = 3 x V        V = videos published in the last N days (newest first)

| Videos published per day | N = 1 (default) | N = 7 | N = 28 | N = 90 |
| :-- | --: | --: | --: | --: |
| 1 | 3 | 21 | 84 | 270 |
| 2 | 6 | 42 | 168 | 540 |
| 3 | 9 | 63 | 252 | **600** (capped at 200 videos; 810 uncapped) |

- **Hard cap: 600 calls (200 videos) per channel per run**, applied whenever the variable is set. The poll stops before the video that
  would exceed it, newest videos are polled first (the oldest are dropped), and it logs a `WARNING` naming the cap, how many videos
  were polled and the variable to lower. 200 is also the number of videos the dashboard shows (`MAX_VIDEOS`). The cap is per channel
  poller, so a run's worst case is channels x 600; the run is one scheduled run a day plus any manual dispatch.
  The store is asked for at most cap/3 + 1 = 201 videos; if it returns that many, a `WARNING` says older videos in the window were
  not read (this matters when quota errors make every video cost one call, so the call cap is never reached).
- **Wall-clock budget: 10 minutes per channel** (`MAX_METRICS_POLL_SECONDS`), then the loop stops with a `WARNING` naming the
  variable. The job's timeout is 30 minutes and this pass runs first; with several channels the budgets add up, so keep N small there.
- **Calls per video are up to 3:** a video older than 3 days costs 2 (no retention call), and a video YouTube has nothing for costs 2
  and writes no row. The table above is the worst case.
- Every widened run ends with one `INFO` line per channel: videos polled, snapshots written, **Analytics calls made** and the cap
  (`last_analytics_calls` counts the real calls, including the retention call, and a video whose first call fails counts as 1).
- The revenue pass (`CHRONOS_ENABLE_REVENUE`) already makes one call per video of the whole channel and is not affected.
- **What a call costs against the quota is not verified here.** YouTube's Analytics quota page says only that "the API server
  evaluates each query to determine its quota cost"; it is not a flat per-call figure and not the Data API's 10,000 units/day.
  Read the real number in Google Cloud Console -> APIs & Services -> YouTube Analytics API -> Quotas before choosing a large N, and
  start small (7 or 28) while watching the poll log's call count. A quota error costs one call per remaining video (the core call
  fails first) and the run keeps going, as it always has.
- Runtime was **not measured** (no live calls were made for this change); the job has a 30 minute timeout.
- **Storage:** a widened poll writes one snapshot row per polled video per day (at most 200 a day per channel; into
  `metrics_snapshots_late` for videos older than 3 days), instead of one or two per video in its lifetime. Retention is the
  bigger table: `retention_points` takes about 100 points per polled video per day and is never pruned, and the mirror sends each
  video's latest curve in one request with a 15 second timeout. That is why a widened poll reads the curve only in a video's
  first 3 days (at most about 3 x 100 points a video, as the default poll gives). The dashboard reads snapshots in chunks and
  splits a chunk that reaches the 1000-row response cap, so many readings per video cost more queries, not wrong numbers, and
  the page reads at most 4 of those chunks at once (`SNAPSHOT_CONCURRENCY`; a page of 200 videos is 8 chunks and each split adds
  two more, so without the bound one page view would open a burst of queries on the member's own session).

## What is not shown, and why

| Item | State | Why |
| :-- | :-- | :-- |
| Subscribers gained / lost | **"Not collected"** | `AnalyticsClient.video_performance` receives `subscribersGained/Lost`, but the poll stores only the other metrics, and `channel_summary` / `daily_timeseries` are not called by anything. There is no stored source, so no number. A collector plus a snapshot table is a **follow-up that needs a migration** (its own PR, drift guard and rollback doc); it is not in this PR. |
| Click-through rate | not shown | The stored `impression_ctr` has no pinned unit anywhere in the repo (ratio or percent). Impressions/CTR stay on the Measurement page until the unit is verified against a real report. |
| Instagram / TikTok results | card: "Connected. Results for this platform are coming." / "Not connected" | Instagram insights need `instagram_business_manage_insights`, which the connect flow does not request; TikTok's video list needs `video.list`, which it does not request. Both would re-consent existing connections. |
| X / Facebook | card: "Coming. This platform cannot be connected yet." | No adapter, no connect flow, no migration (the platform checks of `social_accounts` and `publish_requests` do not allow them yet). |

The platform cards come from a registry (`lib/resultsDashboard/platforms.ts`). `tests/results-dashboard-platforms.test.ts`
reads `modules/social_publish.py` and fails when the registry disagrees with the worker's registered publishers.
A card for a platform without results never carries a digit. An unreadable accounts table makes the cards say "Could not check
right now", not "Not connected".

## Isolation: one organization at a time

This is the main security property, and it is two locks, not one:

1. **RLS** (migration 0018) scopes `videos`, `metrics_snapshots`, `publish_requests` and `social_accounts` to the member's
   organizations.
2. **The route** (`app/api/results/route.ts`, `lib/server/results-dashboard.ts`) also names the current organization
   explicitly: only channels whose `org_id` equals the viewed organization are used (a channel without an `org_id` is nobody's
   and is not used), every query filters by those channel ids / `org_id`, and every returned row is checked against that set again.
   A platform operator can read every tenant through RLS; this is what keeps the dashboard to the organization being viewed.

The route takes `?channel=<id>`; **no `channel` means all channels**, so a channel whose id is literally `all` is an ordinary
channel and cannot collide with it. A channel id of another organization answers **exactly like a channel that does not exist** (404 `not_found`, no database read),
so the route teaches nothing about another tenant. `tests/results-dashboard-routes.test.ts` covers: A cannot read B's channel,
videos, readings, publish requests or connected accounts, with RLS working, with RLS absent, and with every table ignoring its
filters; B sees only B; a channel of another organization equals a missing one.

Reading rows are fetched 25 videos at a time, newest first. PostgREST cuts a response silently at its max rows (default 1000), so
a response at the cap is never trusted: the ids are split and read again until each answer is under it. If even a single video
alone fills the cap, `truncated.snapshots` is set and the page shows a warning that some readings may be missing. (The cap the
loader assumes is `SNAPSHOT_CAP = 1000`; a server configured with a lower max-rows would not be detected.)

A read that fails is an error (`502`), never an empty dashboard. A secondary source that is missing (cross-posts: 0029 not
applied) or fails is named on the page and the rest still shows.

## Publish history

One list, newest first, inside the chosen period: the pipeline's own upload of each video (`videos`) and every cross-post
request (`publish_requests`), with platform, target, time, status and the **privacy the record states**. A record that states no
privacy reads "Visibility not recorded"; the page never calls a video public that the record does not say is public.
`publish_requests.status = published` is shown as "Uploaded" (the upload finished), consistent with CLAUDE.md #3.
A cross-post is dated, and filtered into the period, by **`created_at`** (when it was requested), the same date for both.
Failure and refusal reasons reuse the Publish panel's sentences (`t.publish.reasons`).

## Files

| Piece | Where |
| :-- | :-- |
| Switch | `command-center/lib/resultsDashboard/flag.ts` |
| Pure logic (windows, latest reading, KPIs, top videos, freshness, history) | `lib/resultsDashboard/aggregate.ts`, `format.ts` |
| Platform registry | `lib/resultsDashboard/platforms.ts` |
| Server loader / route | `lib/server/results-dashboard.ts`, `app/api/results/route.ts` |
| Page / UI | `app/(app)/[channel]/analytics/results/page.tsx`, `components/results/*` |
| Strings (en / ru / uz) | `lib/i18n/results-dashboard/*`, key `resultsDashboard.*` |
| Tests | `tests/results-dashboard-*.test.ts(x)`, `tests/test_switch_reachability.py` |

The page sits under `analytics/` (like `studio/regions`) so it adds no top-level section: `tests/navigation.test.ts` requires a
navigation label for every section. It is **not linked from the navigation** yet (it is dark); add the link in the release PR,
not before.

## Releasing

1. Set the repository variable `NIGHTSHIFT_RESULTS_DASHBOARD=on`, run "Deploy web" (a restart is enough; read per request).
2. Open `/{channel}/analytics/results`. A workspace with no connected channel sees "No channel yet"; a channel with no reading shows
   "Not measured".
3. Native speakers should review the ru and uz strings (list in the pull request).
4. Rollback: unset the variable. Nothing was migrated or written.
