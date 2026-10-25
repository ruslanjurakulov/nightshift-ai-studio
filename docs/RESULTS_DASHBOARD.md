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

`modules/intelligence_poller.py` stores `int(metrics.get("views", 0) or 0)` and the like, so when YouTube has no row yet for a
video it stores a **full row of zeros**. A zero on this page would then read as a measurement. The rules, applied in
`lib/resultsDashboard/aggregate.ts` (`buildVideoResults`):

1. A snapshot whose views, likes, comments, watch minutes and average duration are **all exactly 0** is treated as "no data came
   back". It is skipped; the video falls back to its newest non-empty reading, or is "Not measured" (row text "No data yet",
   counted in the note under the figures) when it has none. A snapshot with any non-zero figure, or any null one, is a reading.
2. An average duration of exactly 0 next to views > 0 is **unknown** (null), so it cannot pull the views-weighted average down.
3. A snapshot dated **before the video's publish day** cannot be a reading of that video and is excluded (not shown, not counted).

**Follow-up (worker/database, not in this PR):** the poller should store NULL for metrics YouTube did not return. Then rules 1 and
2 become unnecessary and a stored 0 is always a measured 0.

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
- Every widened run ends with one `INFO` line per channel: videos polled, snapshots written, **Analytics calls made** and the cap
  (`last_analytics_calls` counts the real calls, including the retention call, and a video whose first call fails counts as 1).
- The revenue pass (`CHRONOS_ENABLE_REVENUE`) already makes one call per video of the whole channel and is not affected.
- **What a call costs against the quota is not verified here.** YouTube's Analytics quota page says only that "the API server
  evaluates each query to determine its quota cost"; it is not a flat per-call figure and not the Data API's 10,000 units/day.
  Read the real number in Google Cloud Console -> APIs & Services -> YouTube Analytics API -> Quotas before choosing a large N, and
  start small (7 or 28) while watching the poll log's call count. A quota error costs one call per remaining video (the core call
  fails first) and the run keeps going, as it always has.
- Runtime was **not measured** (no live calls were made for this change); the job has a 30 minute timeout.
- **Storage:** a widened poll writes one `metrics_snapshots` row per polled video per day (at most 200 a day per channel), instead of
  one or two per video in its lifetime. The dashboard reads snapshots in chunks and splits a chunk that reaches the 1000-row
  response cap, so many readings per video cost more queries, not wrong numbers.

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
