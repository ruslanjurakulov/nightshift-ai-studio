# Measurement and the publish gate (Phase 6)

Phase 6 answers four questions the project could not answer before:

1. **What does a video cost?** Nothing recorded cost — there was no column for
   it anywhere.
2. **Which thumbnail and title actually work?** Both variants were generated on
   every run; only A ever shipped, so the experiment was thrown away before it
   ran.
3. **Where do viewers leave?** `averageViewDuration` said *how long* they
   watched. Nothing said *where* they stopped, which is the part a script can
   fix.
4. **What stopped a bad video?** The quality checks reported and were ignored;
   the upload happened regardless.

One rule runs through all of it: **null is not zero.** An unpriced unit is not
free, an unpolled video has unknown click-through, and a video with no curve has
unknown retention. Every aggregate excludes those and says so, rather than
averaging in a zero that would quietly become a fact.

---

## 1. Cost ledger

`modules/cost_ledger.py` · table `video_costs`

The ledger records **quantities**, which the pipeline observes:

| Unit | Recorded at |
| --- | --- |
| `gemini_input_tokens`, `gemini_output_tokens` | every Gemini call that reports usage |
| `tts_characters` | narration synthesis |
| `render_seconds` | wall-clock time of the compositor |
| `pexels_requests` | stock-footage fetches |
| `upload_bytes` | the uploaded file's size |

A **dollar figure is not observed**. Unit prices differ per vendor plan and
change without notice, so a price is applied only when the operator configures a
rate:

```bash
CHRONOS_PRICE_GEMINI_INPUT_TOKENS=0.000000075   # USD per single unit
CHRONOS_PRICE_TTS_CHARACTERS=0.000016
CHRONOS_PRICE_RENDER_SECONDS=0.0002
```

With no rate set, `estimated_usd` stays NULL and the Command Center's
**Measurement** page names the exact `CHRONOS_PRICE_*` variable to set. A video
whose entries are *partly* priced reports no total at all — a partial sum would
understate the real cost and read as if it were the whole thing.

Recording a cost can never break a video: like `event_log`, every method
swallows its own failures.

## 2. Thumbnail and title A/B

`modules/ab_testing.py` · columns `videos.thumbnail_variant`, `videos.title_variant`

Selection alternates by the channel's published-video count (even → A, odd → B),
which is deterministic, needs no extra state, and fills both arms evenly. The
chosen arm is stored on the video, so the result is readable back.

Reading it back (`variant_performance`) compares mean `impression_ctr` from
`metrics_snapshots` and **refuses a verdict** below either floor:

* `MIN_PER_VARIANT = 5` measured videos **per arm**
* `MIN_LIFT = 0.10` relative difference

A video whose CTR was never measured is excluded, not counted as 0. Once there
is a verdict, `choose_variant` favours the winner but still ships one video in
`EXPLORE_EVERY = 5` on the other arm — a thumbnail style that worked in June is
not guaranteed to work in December, and an experiment that stops running stops
being able to tell you.

The dashboard mirrors these constants in `command-center/lib/measurement.ts`.
**Change one, change both** — the dashboard must not name a winner the pipeline
would not act on.

## 3. Audience retention

`modules/retention_analyzer.py` · table `retention_points`

`analytics_client.video_retention()` queries `audienceWatchRatio` across the
`elapsedVideoTimeRatio` dimension, and the Intelligence Poll stores one row per
measured point. `RetentionAnalyzer.as_prompt_text()` turns the stored curves
into two facts the script engine can act on:

* whether the **hook** holds (retention through the first `HOOK_RATIO = 10%`),
* where the **largest cliff** starts, when any drop clears `MIN_CLIFF_DROP`.

Below `MIN_CURVES = 3` usable curves (each needing `MIN_POINTS = 5` points) it
returns `""`, so appending it to a prompt is always safe and one video's story is
never mistaken for a pattern.

## 4. The pre-publish gate — **this changes publish behaviour**

`modules/publish_gate.py` · events `publish.blocked`, `publish.allowed`

Until Phase 6 the originality check was never called from `main.py`, and the
fact-check only wrote a report. The gate now runs **before the upload** and can
stop it:

| Check | Blocks when |
| --- | --- |
| sanity | no title, title over 100 characters, video file missing or under 100 KB, fewer than 2 script sections |
| fact-check | the fact-checker returned failing claims |
| originality | the topic duplicates an already-published video |
| rights | an asset a scene actually uses has `rights.status == "blocked"` in the Video IR (`unknown` only warns — see below) |

Three deliberate properties:

* **It only ever blocks.** There is no path where the gate causes a video to be
  published that would not have been published before.
* **A broken checker warns, never blocks.** If a check itself raises, the video
  ships and the failure is recorded as a warning — an outage in a checker must
  not become an outage in publishing.
* **`--no-upload` is unaffected.** The gate runs and reports; nothing was going
  to be uploaded anyway.

### Turning a check off for one channel

`channels.agent_config.publish_gate` on that channel:

```json
{ "publish_gate": { "block_on_duplicate": false } }
```

The four keys are `enabled`, `block_on_sanity`, `block_on_fact_check` and
`block_on_duplicate` (the originality check). Only an **explicit `false`**
disables one. A missing key, a null, a typo, or `"false"` as a string all leave
the check on — a misconfiguration must fail
towards checking, not towards publishing. `{"enabled": false}` turns the whole
gate off for that channel, which restores exactly the pre-Phase-6 behaviour.

`block_on_rights` (same rule, default on) governs used assets whose rights are
`blocked`. One key works the other way round: `block_on_unknown_rights` is
**off** unless it is an explicit `true`. Until provenance is recorded almost
every asset is `unknown`, so by default unknown rights produce a
`rights_unknown:<count>:<scene ids>` warning, not a block. No Video IR for the
run is a `rights_check_not_run` warning; the counts ride in the event's
`rights` metadata (asset and scene ids only, no paths).

Every decision is emitted as an event carrying the gate's **own reason strings**
— never script text, claim text, or anything that could carry a credential.

---

## 5. Applying the migration

`supabase/migrations/0002_measurement.sql`, run in the Supabase SQL editor.
Additive only: two new tables, four new nullable columns, no drop, no rename, no
delete. Every added column is nullable with no default, because "not measured"
and "measured as zero" are different facts and the schema has to be able to tell
them apart. A fresh project needs only `supabase/schema.sql`, which inlines the
same statements.

RLS posture is unchanged: both new tables are RLS-on, `select` to `authenticated`
only, with no write policy. The anon key alone still reads nothing.

## 6. Where to look in the Command Center

**Measurement** (`/measure`), scoped by the channel switcher like every other
page:

* cost per video, with unpriced units surfaced as the `CHRONOS_PRICE_*` to set;
* the A/B arms, their measured CTR, and the verdict or the reason there isn't one;
* the averaged retention curve, its hook figure and its cliff;
* recent gate decisions and what each one blocked on.

`retention_points` and `metrics_snapshots` carry no `channel_id` of their own —
they belong to a video, so the page scopes them by the videos in the current
selection rather than by weakening the query.

---

# Shorts

`modules/shorts.py` · migration `0003_shorts.sql`

A Short is **derived from the long video that already published**, not rendered
a second time. A second render would double the most expensive stage of the
pipeline for a 30-second clip and would produce different cuts, different Ken
Burns timing and different subtitle placement — the Short is meant to be a
trailer for the long video, so it is cut from the long video.

## The frame

A 16:9 frame does not become 9:16 by cropping: a centre crop throws away two
thirds of the width, and this project's subtitles are laid out nearly
full-width, so cropping would slice words in half. Instead the whole frame is
scaled to 1080 wide and centred on a 1080×1920 canvas, on the compositor's own
background colour. Nothing in the frame is lost.

## The window

The **hook** — the opening section the script engine wrote specifically to stop
a scroll — cut on the audio mixer's own measured section boundary, clamped to
15–60 seconds. That needs no guessing about which moment is "best": it is the
part of the script that already has that job. A timeline that says nothing
usable produces no Short rather than a guessed one.

## Cost, and why it is off by default

**A Short is a second `videos.insert`: about 1,600 more quota units out of the
10,000 a day.** Publishing one every day roughly halves how many long videos the
same Google Cloud project can carry. So Shorts are opt-in per channel, and only
an explicit `true` turns them on:

```json
{ "shorts": { "enabled": true, "max_seconds": 45 } }
```

in that channel's `agent_config`. A missing key, `"true"` as a string, or a typo
all leave Shorts off — nothing starts spending quota because a value was
misread.

## What it can and cannot break

The Short runs **strictly after** its long video has published, which means the
publish gate has already passed and the video is out. Every step from there is
best-effort: a missing moviepy, an unreadable source, a failed upload — each is
logged as `short.failed` and returns. **No failure in this path can turn a
successful run into a failed one.** There is also no A/B arm on a Short: it
ships the long video's own frames, so attributing a thumbnail variant to it
would double-count the experiment.

## Where it lands

The Short is its own row in `videos` — its own YouTube id, its own metrics, its
own retention curve — with `video_format = 'short'` and `parent_video_id` naming
the long video it was cut from. Everything published before migration 0003 is
`'long'`, which is a fact about the history rather than an assumption written
over it. The Command Center's video library marks Shorts with a badge.
